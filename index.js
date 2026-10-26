// @local/dsh-workbench-bot —— 宿主半入口（cordis 插件）
//
// 职责：
//   1. 初始化领域状态（$DSH_HOME/workbench-bot/state.json）
//   2. 确保 5 个默认私聊 + 对应 ds-bot Bot
//   3. 注册业务适配器（meeting/policy/kb/ppt）
//   4. 挂载 HTTP API /api/workbench-bot/v1/*
//   5. Run Coordinator 调度
//
// 零第三方 import：仅 node: 内置模块。
// 声明依赖：webServer（HTTP 路由）、tools（业务工具探测）。
import * as path from 'node:path'
import { StateStore, createStateHome, DEFAULT_AGENTS } from './src/host/state.js'
import { BotBridge } from './src/host/bridge.js'
import { RunCoordinator } from './src/host/runs/coordinator.js'
import { RunExecutor } from './src/host/runs/executor.js'
import { createAdapter } from './src/host/adapters/index.js'
import { createApi } from './src/host/api.js'
import { CapabilityRegistry } from './src/host/registry.js'
import { BusinessTasks } from './src/host/runs/business.js'
import { AgentAdapter } from './src/host/adapters/agent.js'
import { GeneralCapabilities } from './src/host/general.js'

import { installLicense } from './license-http.mjs'; /* PATCH:V5-o2pack-import */
export const inject = ['webServer', 'tools', 'dsBotRt', 'connection', 'llm']

export function apply(ctx, config = {}) {
  /* PATCH:V5-o2pack-apply */
  // 授权门禁（C 形态：本插件无 disposers）：插在 apply 最开头，
  // 保证任何注册/初始化之前门禁就已经可用；清理走 ctx.effect。
  const __lic = installLicense(ctx, { pluginId: 'workbench-bot', prefix: '/api/workbench-bot/v1' });
  try { if (ctx && typeof ctx.effect === 'function') ctx.effect(() => () => { try { __lic.gate.flush(); } catch {} }, 'lic-flush'); } catch {}

  if (config.enabled === false) {
    const api = createApi({ bridge: { ctx }, ctx, enabled: false })
    const dispose = ctx.get('webServer')?.register({
      kind: 'prefix', path: '/api/workbench-bot/v1',
      handler: (req, res) => {
        if (__lic.intercept(req, res)) return; /* PATCH:V5-o2pack-guard */
        return (api.handle(req, res, new URL(req.url, 'http://localhost').pathname, req.method));
      },
    })
    ctx.effect(() => dispose, 'workbench-bot: disabled cleanup')
    return
  }
  const home = config.home || createStateHome(process.env.DSH_HOME)

  // 1. 领域状态
  const store = new StateStore(home)

  // 2. 兼容桥
  const coordinator = new RunCoordinator(store)
  const bridge = new BotBridge({ ctx, store, coordinator })
  const general = new GeneralCapabilities({ store, ctx, bridge })
  general.registerTools()

  // 3. 调度器

  // 4. 业务适配器
  // ppt 走进程内直驱（inproc.js），无需 baseUrl/fetch
  const adapters = {
    meeting: createAdapter('meeting', { ctx }),
    policy: createAdapter('policy', { ctx }),
    kb: createAdapter('kb', { ctx }),
    ppt: createAdapter('ppt', { ctx }),
  }
  // bridge 需要 meeting adapter 做 A17 纪要消歧回显（避免初始化顺序耦合，用 setter 注入）
  bridge.setAdapters(adapters)

  // 4.5 执行引擎（Run step 调度到 adapter）
  const executor = new RunExecutor({ store, coordinator, adapters, bridge, general })
  const business = new BusinessTasks({ store, bridge, coordinator, executor, general })
  adapters.agent = new AgentAdapter(bridge); adapters.business = business
  bridge.business = business; bridge.taskRouter = run => business.route(run); bridge.answerBusiness = (run, question, body) => business.answer(run, question, body)

  // 5. HTTP API
  const ownerId = resolveOwnerId(ctx, config)
  const registry = new CapabilityRegistry({ store, bridge, adapters })
  bridge.registry = registry
  ctx.provide('workbenchBotCapabilities', { register: (manifest, adapter) => registry.register(manifest, adapter), list: () => registry.list() })
  const ready = store.ensure().then(() => bridge.initBots(ownerId)).then(async () => {
    for (const id of ['meeting', 'policy', 'kb', 'ppt']) await registry.register(adapters[id].manifest(), adapters[id])
    await bridge.recover()
    executor.start()
  })
  const api = createApi({ store, coordinator, adapters, bridge, executor, general, ctx })
  let disposeHttp
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    disposeHttp = webServer.register({
      kind: 'prefix',
      path: '/api/workbench-bot/v1',
      handler: async (req, res) => {
        if (__lic.intercept(req, res)) return; /* PATCH:V5-o2pack-guard */
        try { await ready } catch { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'STATE_UNAVAILABLE', message: '协作状态未就绪，请检查诊断日志' } })); return }
        const url = new URL(req.url, 'http://localhost')
        await api.handle(req, res, url.pathname, req.method)
      },
    })
  }

  // 6. 异步初始化（幂等）
  // 多用户隔离说明：dsh-multi-user 网关为每个账号独立启动一个 DSH 实例（各自 DSH_HOME），
  // 故 workbench-bot/state.json 天然落到各账号 home 下，跨账号不串。ownerId 仅作兜底标识，
  // 优先取 connection 服务暴露的 operator/账号，取不到则回退 config.ownerId / DSH_HOME 基名。
  ready.catch(err => {
    // 初始化失败不阻塞 apply，记录后下次重试
    console.error('[workbench-bot] init failed:', err.message)
  })

  // 6.5 Bot 回复回显：订阅 session 事件流，把业务 Bot 的回复写回事件流
  bridge.subscribeReplies()

  // 7. 卸载清理
  ctx.effect(() => {
    return async () => {
      if (typeof disposeHttp === 'function') disposeHttp()
      await executor.close()
      await bridge.close()
    }
  }, 'workbench-bot: cleanup')
}

export const name = 'dsh-workbench-bot'
export { DEFAULT_AGENTS }

// 解析当前账号标识（多用户隔离的兜底键）。优先级：
//   config.ownerId > DSH_HOME 路径中的账号名 > connection operator 账号 > 'default'
//
// ⚠️ 顺序很关键：DSH_HOME **必须**排在 connection 之前。
//   dsh-multi-user 网关下每账号独立 DSH 实例，DSH_HOME = .../users/<username>/home，
//   由它派生的账号名是**稳定**的（重启不变）。
//   而 connection 服务暴露的 operator 在匿名/未登录场景下是 `.anonymous-user-id` 里的
//   随机 UUID —— 曾因把它排在前面，导致**每次实例重启 ownerId 都换一个新 UUID**，
//   默认私聊随之累积（实测 4 次重建 → 20 个默认会话）。
//   connection 只作最后兜底；且 UUID 形态的值一律拒绝（连续性更差，没有兜底价值）。
function resolveOwnerId(ctx, config = {}) {
  if (config.ownerId) return config.ownerId

  // ① DSH_HOME 派生的账号名（稳定、按账号天然隔离）
  const homeBase = process.env.DSH_HOME
  if (typeof homeBase === 'string' && homeBase.length > 0) {
    const segs = homeBase.split(/[\\/]/).filter(Boolean)
    // 形如 .../users/<username>/home → username 在倒数第二段
    if (segs.length >= 2 && segs[segs.length - 1] === 'home') {
      const acct = segs[segs.length - 2]
      if (acct && acct !== 'users') return acct
    }
    const last = segs[segs.length - 1]
    // 宿主实例的 DSH_HOME 形如 ~/.dsh —— 隐藏目录名无意义，改用 HOME 基名
    if (last && !last.startsWith('.')) return last
    const homeSegs = String(process.env.HOME || '').split(/[\\/]/).filter(Boolean)
    if (homeSegs.length > 0) return homeSegs[homeSegs.length - 1]
    return 'host'
  }

  // ② connection 的 operator 账号（仅兜底）
  try {
    const conn = ctx.get && ctx.get('connection')
    const cand = conn?.operator?.account
      ?? conn?.operator?.ownerId
      ?? conn?.operator?.id
      ?? conn?.operator?.name
    // 拒绝随机 UUID（匿名身份每次重启都变，会造成会话累积）
    const isUuid = typeof cand === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cand)
    if (typeof cand === 'string' && cand.length > 0 && !isUuid) return cand
  } catch { /* connection 服务可能未注入 */ }

  return 'default'
}
