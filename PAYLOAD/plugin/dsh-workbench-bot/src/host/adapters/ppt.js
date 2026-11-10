// PPT 适配器：进程内直驱 @local/huiwen-ppt 后端（不走网络、不过鉴权门禁）
// 路由映射见 docs/api-map.md；真实路由表见 huiwen-ppt/server/router.js。
import { MANIFESTS, adapterError } from './base.js'
import { ensureReady, core, callApi, sourceModule, packageVersion, assertPptScope } from './inproc.js'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

export class PptAdapter {
  constructor({ call = callApi, ready = ensureReady, modules = sourceModule, ctx } = {}) {
    // 保留参数兼容（fetchImpl 不再使用，进程内直驱无需 fetch）
    this.call = call; this.ready = ready; this.modules = modules; this.ctx = ctx
  }

  manifest() {
    return MANIFESTS.ppt
  }

  // 进程内直驱的通用请求包装：把 {status,json} 转成业务返回或抛 adapterError
  async _call(routePath, { method = 'GET', body, raw, query } = {}) {
    let r
    try {
      r = await this.call(routePath, { method, body, raw, query })
    } catch (e) {
      throw adapterError('PLUGIN_UNAVAILABLE', `huiwen 进程内直驱失败: ${e.message}`)
    }
    const j = r.json || {}
    if (r.status >= 400) {
      // BOOTING / recoverable 标记 → 映射为可重试错误
      const code = j.code || (j.recoverable ? 'TIMEOUT'
        : r.status === 404 ? 'SOURCE_NOT_FOUND'
        : 'PLUGIN_UNAVAILABLE')
      throw adapterError(code, `huiwen HTTP ${r.status}: ${j.code || ''} ${j.message || j.raw || ''}`, {
        status: r.status, details: j,
      })
    }
    if (j.ok === false || j.error) throw adapterError(j.code || j.error?.code || 'EVIDENCE_REJECTED', j.message || j.error?.message || 'PPT 操作被拒绝')
    return j
  }

  async health() {
    try {
      if (this.ctx && !this.ctx.get?.('workbenchCapabilities')?.list?.().some(p => p.id === 'huiwen-ppt')) throw adapterError('PLUGIN_UNAVAILABLE', '汇文 PPT 插件未启用')
      assertPptScope()
      const boot = (await core()).bootState()
      return { status: ['ready', 'degraded'].includes(boot.state) ? 'ready' : 'unavailable', version: await packageVersion(), reason: boot.state }

    } catch (e) {
      return { status: 'unavailable', version: 'unknown', reason: e.message }
    }
  }

  async invoke({ operation, input, signal, expectedArtifactVersion, modelBudget, retryOf }) {
    if (this.ctx && (await this.health()).status !== 'ready') throw adapterError('PLUGIN_UNAVAILABLE', '汇文 PPT 插件不可用或账号目录未配置')
    await this.ready()
    signal?.throwIfAborted()
    if (modelBudget) {
      const workflow = await this.modules('workflow')
      if (typeof workflow.withModelBudget !== 'function') throw adapterError('MODEL_BUDGET_UNSUPPORTED', '当前 PPT 未启用内部模型预算合同，请安装已审查的兼容构建')
      return workflow.withModelBudget(modelBudget, () => this.invoke({ operation, input, signal, expectedArtifactVersion, retryOf }))
    }
    if (expectedArtifactVersion && input.projectId) {
      return (await this.modules('workflow')).withProjectLock(input.projectId, async () => {
        signal?.throwIfAborted()
        const { meta, state } = await (await this.modules('projects')).loadProject(input.projectId)
        if (meta.version !== expectedArtifactVersion.version || state.current_sha256 !== expectedArtifactVersion.sha256) throw adapterError('VERSION_CONFLICT', 'PPT 项目已被其他入口更新，请刷新基准', { status: 409, details: { currentVersion: meta.version, currentSha256: state.current_sha256 } })
        return this._invoke(operation, input, retryOf)
      })
    }
    return this._invoke(operation, input, retryOf)
  }
  async _invoke(operation, input, retryOf) {
    if (retryOf) {
      if (!['ppt.generate', 'ppt.render'].includes(operation)) throw adapterError('INVALID_OPERATION', '此操作不支持原生任务重试')
      const result = await this._call(`/api/jobs/${encodeURIComponent(retryOf)}/retry`, { method: 'POST' })
      return { ...result, projectId: input.projectId, jobId: result.jobId || result.job_id }
    }
    switch (operation) {
      case 'ppt.list_templates':
        return this._call('/api/templates')
      case 'ppt.create_project': {
        const r = await this._call('/api/projects/new', { method: 'POST', body: { title: input.title } })
        return { projectId: r.project?.id || r.project_id || r.id, ...r }
      }
      // 显式生成大纲（WF-03）：支持指定模型，规避默认模型（huiwen-luna）超 2048 token 截断。
      // huiwen-2-agron（简洁模型）能在 2048 token 内输出完整大纲，已验证通过。
      case 'ppt.generate_outline': {
        const body = { ...(input.modelId ? { model_id: input.modelId } : {}) }
        const r = await this._call(`/api/projects/${input.projectId}/outline/generate`, { method: 'POST', body })
        return { projectId: input.projectId, ...r }
      }
      // 显式选风格（WF-04）：generate 前必需，否则 0.4.x 报 TEMPLATE_SELECTION_REQUIRED。
      case 'ppt.select_style': {
        const body = {
          ...(input.family ? { family: input.family } : {}),
          ...(input.count ? { count: input.count } : {}),
          ...(input.custom ? { custom: input.custom } : {}),
        }
        const r = await this._call(`/api/projects/${input.projectId}/style`, { method: 'POST', body })
        return { projectId: input.projectId, ...r }
      }
      // 上传材料（纪要正文等纯文本）：让 slide-content 逐页正文生成有真实证据可引用，
      // 规避 0.4.x 在「无材料」场景下 evidence_ids 校验几乎必失败的问题。
      case 'ppt.add_material': {
        const r = await this._call(`/api/projects/${input.projectId}/materials`, {
          method: 'POST',
          raw: input.text,
          query: { filename: input.filename || 'material.txt' },
        })
        return { projectId: input.projectId, ...r }
      }
      case 'ppt.generate': {
        const r = await this._call(`/api/projects/${input.projectId}/generate`, {
          method: 'POST', body: { phase: input.phase || 'final' },
        })
        return { jobId: r.jobId || r.job_id, projectId: input.projectId, ...r }
      }
      case 'ppt.render': {
        const r = await this._call(`/api/projects/${input.projectId}/render`, { method: 'POST' })
        return { jobId: r.jobId || r.job_id, projectId: input.projectId, ...r }
      }
      case 'ppt.status': {
        const r = await this._call(`/api/jobs/${input.jobId}`)
        return r
      }
      case 'ppt.configure': {
        const brief = await this.modules('brief')
        // Native outline/content prompts read key_message; notes alone is absent from briefSummary.
        await brief.saveBriefDraft(input.projectId, { title: input.title, page_count: input.pageCount, notes: input.notes || '', key_message: input.notes || '', user_instructions: input.userInstructions || input.notes || '', audience: input.audience || '项目团队', material_policy: 'provided' })
        await brief.confirmBrief(input.projectId, '工作台用户委托', '依据本次用户任务保存需求')
        return { projectId: input.projectId }
      }
      case 'ppt.confirm_samples':
        return this._call(`/api/projects/${input.projectId}/samples/confirm`, { method: 'POST', body: { version: input.version, sha256: input.sha256, confirmed_by: '工作台用户', note: input.note, requirement_review: input.requirement_review } })
      case 'ppt.snapshot':
        return this._call(`/api/projects/${input.projectId}/snapshot`)
      case 'ppt.export': {
        const result = await this._call(`/api/projects/${input.projectId}/export`, { method: 'POST', body: {} })
        if (result.document_state !== 'final') throw adapterError('PPT_NOT_FINAL', '当前文件尚未定稿，请预览草稿并核实要求后确认', { status: 409 })
        return result
      }
      case 'ppt.patch':
        return this._call(`/api/projects/${input.projectId}/patch`, { method: 'POST', body: { version: input.version, expected_sha256: input.sha256, operations: input.operations, source: 'workbench', note: input.note } })
      case 'ppt.revise': {
        const result = await (await this.modules('revise')).reviseFromInstruction(input.projectId, input.instruction, input.modelId, { version: input.version, expected_sha256: input.sha256 })
        if (result.applied !== true) throw adapterError('REVISION_REQUIRED', result.reply || '修改要求未匹配当前可编辑对象，请明确页码和文字', { status: 409 })
        return result
      }

      default:
        throw adapterError('PLUGIN_UNAVAILABLE', `unknown operation: ${operation}`)
    }
  }

  async reconcile({ stepId, externalJobId }) {
    await this.ready()
    if (!externalJobId) throw adapterError('OUTCOME_UNKNOWN', 'no externalJobId to reconcile')
    const r = await this._call(`/api/jobs/${externalJobId}`)
    const job = r.job
    if (!job) throw adapterError('OUTCOME_UNKNOWN', 'PPT 未返回 job 对象')
    const state = { done: 'succeeded', failed: 'failed_terminal', cancelled: 'cancelled', interrupted: 'interrupted' }[job.status] || 'waiting_external'
    return { state, rawStatus: job.status, result: job.result, error: job.error }
  }

  async files(projectId, version, { expectedSha256 } = {}) {
    await this.ready()
    if (!/^v\d{4,}$/.test(version || '')) throw adapterError('SOURCE_NOT_FOUND', 'PPT 版本无效', { status: 404 })
    const boundRead = expectedSha256 !== undefined
    if (boundRead && !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw adapterError('SOURCE_HASH_MISMATCH', '缺少有效的草稿版本校验值', { status: 409 })
    const { dir, meta } = await (await this.modules('projects')).loadProject(projectId)
    if (meta.version !== version && !boundRead) throw adapterError('VERSION_CONFLICT', 'PPT 版本已更新，请刷新', { status: 409 })
    const file = await (await this.modules('exporter')).downloadVersion(projectId, { version })
    const snapshot = boundRead ? undefined : await this._call(`/api/projects/${projectId}/snapshot`)
    let report = snapshot?.report
    if (boundRead) {
      try { report = JSON.parse(await readFile(join(dir, `report-${version}.json`), 'utf8')) } catch { report = null }
      if (!report) throw adapterError('SOURCE_NOT_FOUND', '此版本页面报告缺失', { status: 404 })
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file.path)) hash.update(chunk)
      if (report.version !== version || report.sha256 !== expectedSha256 || hash.digest('hex') !== expectedSha256) throw adapterError('SOURCE_HASH_MISMATCH', '此版本草稿与保存的校验值不一致', { status: 409 })
      // Historical reads may use only that version's renders, never a current snapshot or another path.
      if (!Array.isArray(report.render_pngs) || !report.render_pngs.length || report.render_pngs.some(p => typeof p !== 'string' || !new RegExp(`^renders/${version}/slide-\\d+\\.png$`).test(p))) throw adapterError('SOURCE_NOT_FOUND', '此版本页面路径无效', { status: 404 })
    }
    return { path: file.path, previewPaths: (report?.render_pngs || []).map(p => join(dir, p)), snapshot }
  }
  async cancel({ stepId, externalJobId }) {
    await this.ready()
    if (!externalJobId) throw adapterError('CANCEL_UNSUPPORTED', 'no job id')
    return this._call(`/api/jobs/${externalJobId}/cancel`, { method: 'POST' })
  }
}
