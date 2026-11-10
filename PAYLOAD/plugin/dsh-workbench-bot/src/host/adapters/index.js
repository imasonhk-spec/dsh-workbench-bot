// 四业务适配器统一入口与工厂。
//
// 会议 / 政策 / 知识库 / PPT 均已实现真实业务调用（不再依赖 ctx.tools 注入）：
//   meeting -> JSON 文件直读（meeting.js，复用 meetai 落盘格式）
//   policy  -> 进程内直驱（policy-inproc.js，复用 runPreflight/extractDocument/checkEvidence 纯函数）
//   kb      -> sidecar HTTP 直连（kb-sidecar.js，复用 rag_* task 协议，127.0.0.1:17321）
//   ppt     -> 进程内直驱（ppt.js + inproc.js，复用 huiwen-ppt handlePackRequest）
//
// 各适配器构造函数保留 ctx 参数兼容旧签名，但业务执行不依赖它。
import { MANIFESTS, adapterError } from './base.js'
import { PptAdapter } from './ppt.js'
import { preflight, extract, evidenceCheck, resolveMod } from './policy-inproc.js'
import { KbSidecar } from './kb-sidecar.js'
import { MeetingAdapter } from './meeting.js'
import { callTool, hasTool } from './tool-dispatch.js'

// 政策适配器：优先复用 policy-analysis 已注册的 policy_* 工具（ctx.tools），
// 回退进程内直驱 runPreflight / extractDocument / checkEvidence。
// 门禁链约束次序：preflight -> extract -> evidence_check，门禁失败不可绕过。
export class PolicyAdapter {
  constructor({ ctx } = {}) {
    this.ctx = ctx
  }

  manifest() { return MANIFESTS.policy }

  async health() {
    // 优先看工具是否已注册；否则尝试进程内直驱（能 import 组合根即 ready）。
    if (hasTool(this.ctx, 'policy_preflight') && hasTool(this.ctx, 'policy_extract') && hasTool(this.ctx, 'policy_evidence_check')) {
      return { status: 'ready', version: '1.0.0', detail: 'ctx.tools' }
    }
    if (this.ctx) return { status: 'unavailable', version: 'unknown', reason: '政策插件工具未启用' }
    try {
      await resolveMod()
      return { status: 'ready', version: '1.0.0', detail: 'inproc' }
    } catch (e) {
      return { status: 'unavailable', version: 'unknown', reason: e.message }
    }
  }

  async invoke({ operation, input, signal }) {
    // 1) 优先 ctx.tools（policy_* 工具）
    const toolMap = {
      'policy.preflight': 'policy_preflight',
      'policy.extract': 'policy_extract',
      'policy.evidence_check': 'policy_evidence_check',
    }
    const toolName = toolMap[operation]
    if (toolName) {
      const r = await callTool(this.ctx, toolName, input || {}, signal)
      if (r !== undefined) return r
    }

    if (this.ctx) throw adapterError('PLUGIN_UNAVAILABLE', '政策插件工具未注册；不会绕过禁用状态')
    // 2) trusted standalone invocation
    switch (operation) {
      case 'policy.preflight':
        return preflight(input || {})
      case 'policy.extract':
        return extract(input || {}, signal)
      case 'policy.evidence_check':
        return evidenceCheck(input || {})
      default:
        throw adapterError('PLUGIN_UNAVAILABLE', `unknown operation: ${operation}`)
    }
  }
}

// 知识库适配器：优先复用 raganything-kb 已注册的 rag_* 工具（ctx.tools），
// 自动继承其正确的 sidecar 端口/token/config；ctx.tools 不可用时回退 sidecar HTTP 直连。
export class KbAdapter {
  constructor({ ctx, baseUrl, fetchImpl, token } = {}) {
    this.ctx = ctx
    this.sidecar = new KbSidecar({ baseUrl, fetchImpl, token })
  }

  manifest() { return MANIFESTS.kb }

  async health() {
    // 优先看工具是否已注册；否则探测 sidecar。
    if (hasTool(this.ctx, 'rag_query') || hasTool(this.ctx, 'rag_docs')) {
      return { status: 'ready', version: '1.0.0', detail: 'ctx.tools' }
    }
    const h = await this.sidecar.health()
    return { status: h.status, version: '1.0.0', detail: h.detail }
  }

  async invoke({ operation, input, signal, onAccepted }) {
    // 1) 优先 ctx.tools（rag_* 工具，token/端口全自动）
    if (operation === 'kb.query') {
      const scope = validateScope(input.scope)
      const args = { query: input.query, mode: input.mode, only_need_context: true, ...scope }
      const r = await this.callRemoteTool('rag_query', args, signal)
      if (r !== undefined) return { answer: r, scope, via: 'ctx.tools' }
    } else if (operation === 'kb.list_docs') {
      const r = await callTool(this.ctx, 'rag_docs', {}, signal)
      if (r !== undefined) return { documents: r, via: 'ctx.tools' }
    } else if (operation === 'kb.status') {
      const r = await callTool(this.ctx, 'rag_status', {}, signal)
      if (r !== undefined) return { status: r, via: 'ctx.tools' }
    } else if (operation === 'kb.ingest') {
      const r = await this.callRemoteTool('rag_ingest', input, signal)
      if (r !== undefined) return { ingest: r, via: 'ctx.tools' }
    }

    // 2) 回退 sidecar HTTP 直连
    switch (operation) {
      case 'kb.query': {
        const params = {
          query: input.query,
          ...(input.mode ? { mode: input.mode } : {}),
          only_need_context: true,
          scope: validateScope(input.scope),
        }
        const taskId = await this.startTask('query', params)
        await onAccepted?.(taskId)
        const result = await this.sidecar.waitTask(taskId, { signal })
        return { mode: result?.mode, answer: result?.result?.answer ?? result?.answer ?? result, scope: input.scope, externalTaskId: taskId, via: 'sidecar' }
      }
      case 'kb.list_docs': {
        const r = await this.sidecar.documents()
        return { documents: r?.documents ?? [], total: r?.total ?? 0, via: 'sidecar' }
      }
      case 'kb.ingest': {
        const params = { path: input.path, ...(input.title ? { title: input.title } : {}) }
        const taskId = await this.startTask('ingest', params)
        await onAccepted?.(taskId)
        return { taskId, op: 'ingest', via: 'sidecar' }
      }
      case 'kb.status': {
        return this.sidecar.status()
      }
      default:
        throw adapterError('PLUGIN_UNAVAILABLE', `unknown operation: ${operation}`)
    }
  }

  async callRemoteTool(name, input, signal) {
    try { return await callTool(this.ctx, name, input, signal) }
    catch (error) {
      throw Object.assign(adapterError('OUTCOME_UNKNOWN', `知识库工具未提供远端停止收据：${error.message}`), { remoteOutcomeUnknown: true })
    }
  }

  async startTask(operation, params) {
    try {
      const taskId = await this.sidecar.startTask(operation, params)
      if (typeof taskId !== 'string' || !taskId) throw new Error('知识库未返回任务身份')
      return taskId
    } catch (error) {
      throw Object.assign(adapterError('OUTCOME_UNKNOWN', `知识库提交结果不明：${error.message}`), { remoteOutcomeUnknown: true })
    }
  }

  async cancel({ externalJobId }) {
    if (!externalJobId) throw adapterError('CANCEL_UNSUPPORTED', '知识库任务身份未知')
    await this.sidecar.cancelTask(encodeURIComponent(externalJobId))
  }

  async reconcile({ externalJobId, resolvedInput, input }) {
    const task = await this.sidecar.getTask(encodeURIComponent(externalJobId))
    const rawStatus = task?.state ?? task?.status
    if (['done', 'succeeded', 'complete'].includes(rawStatus)) return { state: 'succeeded', rawStatus, result: { answer: task?.result?.answer ?? task?.answer ?? task, scope: (resolvedInput ?? input)?.scope, externalTaskId: externalJobId, via: 'sidecar' } }
    if (['error', 'failed'].includes(rawStatus)) return { state: 'failed_terminal', rawStatus, error: { code: 'KB_TASK_FAILED', message: String(task.error || '知识库任务失败') } }
    if (rawStatus === 'cancelled') return { state: 'cancelled', rawStatus }
    return { state: 'outcome_unknown', rawStatus }
  }
}

// 适配器工厂
export function createAdapter(kind, opts) {
  switch (kind) {
    case 'ppt': return new PptAdapter(opts)
    case 'meeting': return new MeetingAdapter(opts)
    case 'policy': return new PolicyAdapter(opts)
    case 'kb': return new KbAdapter(opts)
    default: throw adapterError('PLUGIN_UNAVAILABLE', `unknown adapter kind: ${kind}`)
  }
}

export function validateScope(scope) {
  const result = {}
  for (const key of ['files', 'folders']) if (scope?.[key]?.length) {
    if (!Array.isArray(scope[key]) || scope[key].length > 100 || scope[key].some(v => typeof v !== 'string' || !v.trim() || v.startsWith('/') || v.split(/[\\/]/).some(s => s === '..' || s === '.') || v.length > 500)) throw adapterError('PROJECT_SCOPE_REQUIRED', '指定有效项目目录或文件')
    result[key] = [...new Set(scope[key])]
  }
  if (!Object.keys(result).length) throw adapterError('PROJECT_SCOPE_REQUIRED', '检索前必须指定项目范围')
  return result
}
