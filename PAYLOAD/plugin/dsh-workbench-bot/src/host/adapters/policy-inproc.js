// 政策适配器进程内直驱：直接 import @local/policy-analysis 的三个纯函数。
//
// 为什么能进程内直驱
//   @local/policy-analysis 的门禁链是确定性纯函数，零 ctx 依赖：
//     runPreflight(input)    -> { allowed, nextQuestion?, auditId? } | { allowed:true, directives }
//     extractDocument(input, signal) -> 抽取结构化报告
//     checkEvidence(input)   -> { missingFields[], warnings[], ... }
//   这些函数不访问 ctx.tools / ctx.webServer，只做输入校验 + 规则编排，
//   因此可以直接 createRequire 解析后调用，与 huiwen-ppt 的 inproc.js 同源。
//
// 门禁链约束（不可绕过）：
//   preflight -> extract -> evidence_check；preflight 返回 allowed:false 时
//   后续 extract 一律拒绝，确保「公开性确认 → 唯一来源 → 角色 → 模式」硬门禁生效。
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { adapterError } from './base.js'

const PKG = '@local/policy-analysis'

let modPromise

/** 解析并加载 policy-analysis 组合根（确保与插件本体同一模块实例）。 */
function mod() {
  modPromise ??= (async () => {
    const require_ = createRequire(import.meta.url)
    let base
    try {
      base = path.dirname(realpathSync(require_.resolve(PKG + '/package.json')))
    } catch {
      base = path.dirname(realpathSync(require_.resolve(PKG)))
    }
    return await import(pathToFileURL(path.join(base, 'index.js')).href)
  })()
  return modPromise
}

// 避免顶层未用 pathToFileURL 报错：单独 import
import { pathToFileURL } from 'node:url'

/** 仅解析并加载组合根（不触发任何业务副作用），供 health 探测使用。 */
export async function resolveMod() {
  return mod()
}

/** 执行 preflight 门禁。返回 { allowed, nextQuestion?, auditId? } 或 { allowed:true, directives }。 */
export async function preflight(input) {
  const m = await mod()
  try {
    return await m.runPreflight(input || {})
  } catch (e) {
    throw adapterError('PLUGIN_UNAVAILABLE', `policy preflight 失败: ${e.message}`)
  }
}

/** 执行 extract 抽取。返回结构化报告。 */
export async function extract(input, signal) {
  const m = await mod()
  try {
    return await m.extractDocument(input || {}, signal)
  } catch (e) {
    throw adapterError('PLUGIN_UNAVAILABLE', `policy extract 失败: ${e.message}`)
  }
}

/** 执行 evidence_check 证据校验。返回 { missingFields[], warnings[], ... }。 */
export async function evidenceCheck(input) {
  const m = await mod()
  try {
    return await m.checkEvidence(input || {})
  } catch (e) {
    throw adapterError('PLUGIN_UNAVAILABLE', `policy evidence_check 失败: ${e.message}`)
  }
}
