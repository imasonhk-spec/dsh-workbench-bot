// 业务工具分发：优先通过 ctx.tools 复用业务插件已注册的 dsh 工具
// （tool.execute(args, { signal })），自动继承其正确的 sidecar 端口 / token / config。
//
// 为什么优先 ctx.tools 而非自己直连
//   业务插件（dsh-meetai / policy-analysis / dsh-raganything-kb）已经把自己的
//   能力注册为 dsh 工具（ctx.tools.register），且工具闭包内部持有正确的运行时
//   依赖（raganything-kb 的 sidecar manager 含 sidecarHost/sidecarPort/token；
//   meetai 的会议 CRUD；policy 的门禁链）。复用这些工具 = 零复制端口/token/config，
//   且与业务插件面板看到的数据完全一致。
//
//   只有当 ctx.tools 不可用（冷启动 / 未注入 / 工具未注册）时才回退到各自的
//   兜底直连（sidecar HTTP / 进程内直驱 / JSON 文件直读）。
//
// 最小 exec 上下文：业务工具的 execute(args, exec) 通常只用 exec.signal。
// 这里构造 { signal } 即可；个别工具用 exec.run_in_background 等字段时按需扩展。
export function makeExec(signal) {
  return { signal: signal || new AbortController().signal }
}

/** 从 ctx 拿到 ToolRuntime（可能是 ctx.tools 或 ctx.get('tools')）。 */
export function getToolRuntime(ctx) {
  if (!ctx) return null
  try {
    if (typeof ctx.get === 'function') {
      const t = ctx.get('tools')
      if (t && typeof t.get === 'function') return t
    }
    if (ctx.tools && typeof ctx.tools.get === 'function') return ctx.tools
  } catch { /* tools 服务可能未注入 */ }
  return null
}

/**
 * 通过 ctx.tools 调用一个已注册的业务工具。
 * @param {object} ctx DSH Host 上下文
 * @param {string} toolName 工具名，如 'rag_query'
 * @param {object} args 工具参数
 * @param {AbortSignal} signal 取消信号
 * @returns 工具返回的 canonical 值；工具不存在时返回 undefined（调用方回退直连）。
 */
export async function callTool(ctx, toolName, args, signal) {
  const rt = getToolRuntime(ctx)
  if (!rt) return undefined
  let tool
  try {
    tool = rt.get(toolName)
  } catch {
    tool = undefined
  }
  if (!tool || typeof tool.execute !== 'function') return undefined
  return tool.execute(args || {}, makeExec(signal))
}

/**
 * 检查某个工具是否已注册（用于 health 判定）。
 */
export function hasTool(ctx, toolName) {
  const rt = getToolRuntime(ctx)
  if (!rt) return false
  try {
    return typeof rt.get(toolName)?.execute === 'function'
  } catch {
    return false
  }
}
