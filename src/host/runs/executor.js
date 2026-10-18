import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fail, deduplicate } from '../roles.js'
import { budgetExhausted } from './budget.js'
import { validateScope } from '../adapters/index.js'

const TERMINAL = new Set(['delivered', 'cancelled', 'failed_terminal'])
const RETRYABLE_MODEL_ERRORS = new Set(['LLM_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_BAD_OUTPUT', 'LLM_OUTPUT_TRUNCATED'])
export class RunExecutor {
  constructor({ store, coordinator, adapters = {}, bridge, general }) {
    Object.assign(this, { store, coordinator, adapters, bridge, general })
    this.running = new Set(); this.executing = new Set(); this.controllers = new Map(); this.projectLocks = new Map()
  }
  listAdapters() { return Object.keys(this.adapters) }
  adapterFor(step) {
    const adapter = this.adapters[step.adapterId]
    if (!adapter) throw fail('PLUGIN_UNAVAILABLE', `业务插件 ${step.adapterId} 不可用`, 503)
    return adapter
  }
  operation(step) {
    const op = this.adapterFor(step).manifest().operations.find(o => o.name === step.operation)
    if (!op) throw fail('OPERATION_UNAVAILABLE', `未注册操作 ${step.operation}`, 503)
    return op
  }
  steps(runId) { return Object.values(this.store.state.steps).filter(s => s.runId === runId && s.planRevision === this.store.state.runs[runId].planRevision) }
  async update(runId, change) {
    return this.store.transaction(() => {
      const run = this.store.state.runs[runId]
      change(run); run.revision++
      this.store.emit(run.conversationId, 'run.updated', runId, run)
    })
  }
  async question(runId, step, text, field = 'gate') {
    if (this.bridge) return this.bridge.askUser(this.store.state.runs[runId].conversationId, text, { runId, stepId: step.id, field, askedByAgentId: step.adapterId })
    return this.update(runId, run => {
      const id = `question_${randomUUID()}`
      this.store.state.questions[id] = { id, ownerId: run.ownerId, conversationId: run.conversationId, runId, stepIds: [step.id], field, text, state: 'open' }
      run.state = 'waiting_user'
    })
  }
  exhausted(run) { return budgetExhausted(run) }
  modelBudget(runId, step) {
    return {
      beforeRequest: async ({ maxTokens = 4000 } = {}) => {
        const rejected = await this.store.transaction(() => {
          const run = this.store.state.runs[runId]
          if (run.state !== 'running' || step.planRevision !== run.planRevision) return 'INTERRUPTED'
          if (this.exhausted(run)) {
            run.state = 'blocked'; run.blockedReason = 'BUDGET_EXHAUSTED'; run.revision++
            this.store.emit(run.conversationId, 'run.updated', runId, run)
            return 'BUDGET_EXHAUSTED'
          }
          run.usage.requests++; run.usage.pptRequests = (run.usage.pptRequests || 0) + 1
          this.store.emit(run.conversationId, 'run.updated', runId, run)
          return null
        })
        if (rejected) throw fail(rejected, rejected === 'BUDGET_EXHAUSTED' ? '模型预算已用尽' : '任务已停止')
        return Math.min(4000, Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 4000)
      },
      recordUsage: async ({ tokens }) => {
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw fail('TOKEN_USAGE_UNAVAILABLE', '模型未返回可信Token用量，任务已停止')
        await this.store.transaction(() => {
          const run = this.store.state.runs[runId]
          run.usage.tokens += tokens; run.usage.pptTokens = (run.usage.pptTokens || 0) + tokens
          this.store.emit(run.conversationId, 'run.updated', runId, run)
        })
      },
    }
  }
  async advance(runId) {
    if (this.running.has(runId)) return { state: 'already_running' }
    let run = this.store.state.runs[runId]
    if (!run || TERMINAL.has(run.state) || ['waiting_user', 'paused', 'blocked', 'failed_retryable'].includes(run.state)) return { state: run?.state }
    this.running.add(runId)
    try {
      if (this.bridge && !run.startedAt) await this.bridge.roles.admit(runId, run.participantAgentIds || [])
      await this.update(runId, r => {
        if (TERMINAL.has(r.state) || ['waiting_user', 'paused', 'blocked', 'failed_retryable'].includes(r.state)) return
        r.state = 'running'; r.startedAt ??= Date.now()
      })
      if (run.state !== 'running') return { state: run.state }
      for (const step of Object.values(this.store.state.steps).filter(s => s.runId === runId)) if (['running', 'waiting_external', 'outcome_unknown', 'interrupted'].includes(step.state) || step.state === 'cancelled' && step.externalJobId && step.adapterId === 'ppt') await this.reconcile(runId, step)
      for (;;) {
        run = this.store.state.runs[runId]
        if (run.state !== 'running') break
        const steps = this.steps(runId)
        const oldWrites = Object.values(this.store.state.steps).filter(s => s.runId === runId && s.planRevision !== run.planRevision && s.effect !== 'read')
        if (oldWrites.some(s => s.state === 'outcome_unknown')) { await this.update(runId, r => { r.state = 'blocked'; r.blockedReason = 'OUTCOME_UNKNOWN' }); break }
        if (oldWrites.some(s => ['running', 'waiting_external'].includes(s.state))) break
        if (steps.some(s => ['outcome_unknown', 'interrupted'].includes(s.state))) { await this.update(runId, r => { r.state = 'blocked'; r.blockedReason = 'OUTCOME_UNKNOWN' }); break }
        if (steps.some(s => s.state === 'failed_terminal')) { await this.update(runId, r => { r.state = 'failed_terminal' }); break }
        if (steps.some(s => s.state === 'failed_retryable')) { await this.update(runId, r => { r.state = 'failed_retryable' }); break }
        if (!run.pendingUserUpdates?.length && steps.length && steps.every(s => s.state === 'succeeded')) {
          const revision = run.planRevision
          for (const step of steps.filter(s => s.operation === 'ppt.export' && s.publicationPending)) await this.persistPpt(runId, step)
          await this.update(runId, r => { if (!r.pendingUserUpdates?.length && r.state === 'running' && r.planRevision === revision) r.state = 'validating' })
          if (run.state !== 'validating' || run.planRevision !== revision || run.pendingUserUpdates?.length) continue
          if (run.taskSpec.deliverable === 'ppt' && !Object.values(this.store.state.artifacts).some(a => a.runId === runId && a.status === 'ready' && a.kind === 'ppt' && a.planRevision === run.planRevision)) throw fail('OUTPUT_INVALID', '缺少经验证的最终 PPT 成品')
          await this.update(runId, r => { if (!r.pendingUserUpdates?.length && r.state === 'validating' && r.planRevision === revision) r.state = 'delivered' }); if (run.state === 'running') continue; break
        }
        if (this.exhausted(run)) { await this.update(runId, r => { r.state = 'blocked'; r.blockedReason = 'BUDGET_EXHAUSTED' }); break }
        const next = steps.find(s => (!run.pendingUserUpdates?.length || run.pendingUpdateStepIds?.includes(s.id)) && this.coordinator.isStepRunnable(s, run))
        if (!next) break
        await this.execute(runId, next)
      }
      return { state: this.store.state.runs[runId].state }
    } catch (error) {
      await this.update(runId, r => { if (!TERMINAL.has(r.state)) { r.state = 'blocked'; r.blockedReason = error.code || 'EXECUTION_FAILED'; r.error = error.message } })
      return { state: this.store.state.runs[runId].state }
    } finally { this.running.delete(runId) }
  }
  resolve(input) {
    if (Array.isArray(input)) return input.map(v => this.resolve(v))
    if (input && typeof input === 'object') {
      if (typeof input.$ref === 'string') {
        const [id, ...fields] = input.$ref.split('.'), step = this.store.state.steps[id]
        if (!step || step.state !== 'succeeded') throw fail('DEPENDENCY_NOT_READY', '引用的上游结果未完成')
        const value = fields.reduce((v, k) => v?.[k], step.result)
        if (value === undefined) throw fail('RESULT_FIELD_MISSING', `上游缺少 ${input.$ref}`)
        return structuredClone(value)
      }
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, this.resolve(v)]))
    }
    return input
  }
  async cancelExternal(runId, step) {
    if (!step.externalJobId || !this.adapters[step.adapterId]?.cancel) return
    try { await this.adapters[step.adapterId].cancel(step) }
    catch (error) { await this.update(runId, () => { step.cancelError = error.message; step.state = 'outcome_unknown' }) }
  }
  async execute(runId, original) {
    if (this.executing.has(original.id)) return
    this.executing.add(original.id)
    const run = this.store.state.runs[runId], id = original.id
    let operation, controller, lockKey, admitted = false
    try {
      operation = this.operation(original)
      const input = this.resolve(original.input)
      const supplements = run.taskSpec.constraints?.userMessages
      if (supplements?.length) {
        if (original.operation === 'agent.analyze') input.taskConstraints = structuredClone(supplements)
        if (original.operation === 'ppt.configure') input.notes = `${input.notes || ''}\n用户补充说明：\n${supplements.join('\n')}`
        if (original.operation === 'ppt.revise') input.instruction = `${input.instruction || ''}\n用户补充说明：\n${supplements.join('\n')}`
      }
      const adapter = this.adapterFor(original)
      if (adapter.health && (await adapter.health()).status !== 'ready') throw fail('PLUGIN_UNAVAILABLE', `业务插件 ${original.adapterId} 当前不可用`, 503)
      if (run.state !== 'running' || original.planRevision !== run.planRevision) return
      lockKey = operation.effect !== 'read' && input.projectId ? `${run.ownerId}:${input.projectId}` : null
      if (lockKey && this.projectLocks.has(lockKey) && this.projectLocks.get(lockKey) !== runId) throw fail('PROJECT_BUSY', '同一项目正在生成，请稍后重试', 409)
      if (lockKey && Object.values(this.store.state.steps).some(s => s.runId !== runId && this.store.state.runs[s.runId]?.ownerId === run.ownerId && s.resolvedInput?.projectId === input.projectId && ['running', 'waiting_external', 'outcome_unknown'].includes(s.state))) throw fail('PROJECT_BUSY', '同一项目有尚未对账的操作', 409)
      if (lockKey) this.projectLocks.set(lockKey, runId)
      await this.update(runId, r => {
        if (r.state !== 'running' || original.planRevision !== r.planRevision) return
        const step = this.store.state.steps[id]
        if (step.state !== 'queued') return
        step.state = 'running'; step.attempt++; step.resolvedInput = input; step.effect = operation.effect; step.startedAt = Date.now()
        r.usage.operations = (r.usage.operations || 0) + 1
        admitted = true
      })
      if (!admitted || run.state !== 'running' || original.planRevision !== run.planRevision) return
      controller = new AbortController(); this.controllers.set(id, controller)
      const timeout = setTimeout(() => controller.abort(fail('TIMEOUT', '业务操作超时')), operation.timeoutMs || 60000)
      timeout.unref?.()
      let result
      const attempt = original.attempt
      try {
        const invocation = this.adapterFor(original).invoke({ operation: original.operation, input, retryOf: original.retryOf, signal: controller.signal, modelBudget: original.adapterId === 'ppt' ? this.modelBudget(runId, original) : undefined, expectedArtifactVersion: original.adapterId === 'ppt' && operation.effect !== 'read' && run.pptHeadVersion ? { version: run.pptHeadVersion, sha256: run.pptHeadSha256 } : undefined, ownerId: run.ownerId, conversationId: run.conversationId, runId, stepId: id, attempt: original.attempt, planRevision: original.planRevision, idempotencyKey: original.idempotencyKey }).then(async value => {
          // An abort can finish our wait before a remote write returns its job id.
          if (controller.signal.aborted) {
            const jobId = value?.jobId || value?.taskId || value?.sessionId
            await this.update(runId, r => {
              if (original.attempt !== attempt) return
              original.lateResult = value
              if (jobId) { original.externalJobId = jobId; original.result = value; original.state = 'waiting_external' }
              else if (!value?.waitingUser && value?.allowed !== false) {
                original.result = value
                original.state = value?.ok === false || value?.pass === false ? 'failed_terminal' : r.state === 'cancelled' || original.planRevision !== r.planRevision ? 'superseded' : 'succeeded'
                if (original.operation === 'ppt.create_project' && value?.projectId) r.projectId = value.projectId
                if (original.adapterId === 'ppt' && value?.version && value?.sha256) { r.pptHeadVersion = value.version; r.pptHeadSha256 = value.sha256 }
              }
            })
            if (jobId && original.attempt === attempt && this.store.state.runs[runId].state === 'cancelled') await this.cancelExternal(runId, original)
            if (!jobId && original.attempt === attempt && original.state === 'succeeded' && original.operation === 'ppt.export') {
              try { await this.persistPpt(runId, original) }
              catch (error) { await this.update(runId, () => { original.state = 'failed_terminal'; original.error = { code: error.code, message: error.message } }) }
            }
          }
          return value
        })
        this.bridge?.track(invocation)
        result = await Promise.race([
          invocation,
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        ])
      } finally { clearTimeout(timeout) }
      if (this.store.state.runs[runId].state === 'cancelled' || original.planRevision !== this.store.state.runs[runId].planRevision) {
        await this.update(runId, r => {
          const jobId = result?.jobId || result?.taskId || result?.sessionId
          const step = this.store.state.steps[id]; step.state = jobId ? 'waiting_external' : 'superseded'; step.lateResult = result
          if (jobId) { step.externalJobId = jobId; step.result = result }
          if (original.operation === 'ppt.create_project') r.projectId = result.projectId
          if (original.adapterId === 'ppt' && result.version && result.sha256) { r.pptHeadVersion = result.version; r.pptHeadSha256 = result.sha256 }
        })
        if (this.store.state.runs[runId].state === 'cancelled') await this.cancelExternal(runId, original)
        return
      }
      if (result?.waitingUser) {
        await this.update(runId, () => { this.store.state.steps[id].state = 'waiting_user' }); return
      }
      if (result?.allowed === false) {
        await this.update(runId, () => { this.store.state.steps[id].state = 'waiting_user'; this.store.state.steps[id].result = result })
        await this.question(runId, original, result.nextQuestion || '请补充业务门禁信息'); return
      }
      if (result?.ok === false || result?.pass === false) throw fail(result.code || 'EVIDENCE_REJECTED', result.message || '业务校验拒绝，不能交付')
      const jobId = result?.jobId || result?.taskId || result?.sessionId
      await this.update(runId, () => {
        const step = this.store.state.steps[id]; step.result = result
        step.state = jobId ? 'waiting_external' : 'succeeded'; if (jobId) step.externalJobId = jobId
        if (original.operation === 'ppt.create_project') this.store.state.runs[runId].projectId = result.projectId
        if (original.adapterId === 'ppt' && result.version && result.sha256) { run.pptHeadVersion = result.version; run.pptHeadSha256 = result.sha256 }
      })
      if (!jobId && original.operation === 'ppt.export') await this.persistPpt(runId, original)
    } catch (error) {
      await this.update(runId, r => {
        if (!admitted && (r.state !== 'running' || original.planRevision !== r.planRevision)) return
        const step = this.store.state.steps[id]
        step.error = { code: error.code || 'EXECUTION_FAILED', message: error.message }
        step.state = operation?.effect !== 'read' && step.state === 'running' && ['TIMEOUT', 'PLUGIN_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(error.code) ? 'outcome_unknown' : error.status === 409 || ['PLUGIN_UNAVAILABLE', 'TIMEOUT', 'MODEL_UNAVAILABLE'].includes(error.code) || RETRYABLE_MODEL_ERRORS.has(error.code) ? 'failed_retryable' : 'failed_terminal'
        if (['BUDGET_EXHAUSTED', 'INTERRUPTED', 'MODEL_BUDGET_UNSUPPORTED', 'TOKEN_USAGE_UNAVAILABLE'].includes(error.code)) step.state = 'failed_retryable'
        if (r.state === 'running' && step.planRevision === r.planRevision && step.operation === 'ppt.configure' && r.taskSpec.modifyMode === 'regenerate' && error.code === 'VERSION_CONFLICT' && typeof error.details?.currentVersion === 'string' && error.details.currentVersion && typeof error.details.currentSha256 === 'string' && error.details.currentSha256 && !this.steps(runId).some(s => s.adapterId === 'ppt' && s.state === 'succeeded')) {
          const id = `question_${randomUUID()}`, choice = { version: error.details.currentVersion, sha256: error.details.currentSha256 }
          const text = `PPT 项目当前为 ${choice.version}，本任务基准为 ${r.pptHeadVersion}。是否明确以当前版本继续重新生成？旧版保留，已验证条件与来源不变；未确认不会写入。`
          this.store.state.questions[id] = { id, ownerId: r.ownerId, conversationId: r.conversationId, runId, stepIds: [step.id], askedBy: 'ppt', field: 'pptBaseVersion', text, choices: [choice], state: 'open', status: 'open', createdAt: Date.now() }
          step.state = 'waiting_user'; r.state = 'waiting_user'
          this.store.emit(r.conversationId, 'message.committed', id, { messageId: id, sender: { type: 'agent', id: 'ppt' }, type: 'question', text, questionId: id, runId })
        }
        if (r.state === 'cancelled') step.state = step.effect === 'read' ? 'cancelled' : 'outcome_unknown'
      })
    } finally { this.executing.delete(id); if (controller && this.controllers.get(id) === controller) this.controllers.delete(id); if (admitted && lockKey && this.projectLocks.get(lockKey) === runId) this.projectLocks.delete(lockKey) }
  }
  async reconcile(runId, step) {
    const attempt = step.attempt, externalJobId = step.externalJobId, state = step.state
    const current = () => step.attempt === attempt && step.externalJobId === externalJobId && step.state === state
    if (!step.externalJobId) {
      await this.update(runId, () => { if (current()) step.state = step.effect === 'read' ? 'queued' : 'outcome_unknown' }); return
    }
    try {
      const result = await this.adapterFor(step).reconcile({ ...step, externalJobId: step.externalJobId })
      await this.update(runId, () => {
        if (!current()) return
        step.state = result.state; step.rawStatus = result.rawStatus
        if (result.state === 'failed_terminal' && RETRYABLE_MODEL_ERRORS.has(result.error?.code)) step.state = 'failed_retryable'
        if (result.error?.code === 'BUDGET_EXHAUSTED') {
          const run = this.store.state.runs[runId]
          step.state = run.state === 'running' && !this.exhausted(run) ? 'queued' : 'failed_retryable'
          if (step.planRevision === run.planRevision && this.exhausted(run) && !TERMINAL.has(run.state) && !['paused', 'waiting_user'].includes(run.state)) { run.state = 'blocked'; run.blockedReason = 'BUDGET_EXHAUSTED' }
        }
        if (['INTERRUPTED', 'TOKEN_USAGE_UNAVAILABLE', 'MODEL_BUDGET_UNSUPPORTED'].includes(result.error?.code)) {
          const run = this.store.state.runs[runId]
          step.state = result.error.code === 'INTERRUPTED' && run.state === 'running' ? 'queued' : 'failed_retryable'
        }
        if (result.state === 'succeeded') {
          step.result = { ...step.result, ...result.result }; delete step.error
          const run = this.store.state.runs[runId]
          if (step.adapterId === 'ppt' && step.result.version && step.result.sha256) { run.pptHeadVersion = step.result.version; run.pptHeadSha256 = step.result.sha256 }
        }
        if (result.error) step.error = result.error
        if (step.adapterId === 'ppt' && ['ppt.generate', 'ppt.render'].includes(step.operation) && ['interrupted', 'cancelled'].includes(result.state)) {
          step.state = 'failed_retryable'
          step.error = result.error || { code: 'NATIVE_JOB_STOPPED', message: '原生 PPT 任务已停止，可显式重试同一项目' }
        }
        if (step.planRevision !== this.store.state.runs[runId].planRevision && !['waiting_external', 'outcome_unknown'].includes(result.state)) { step.state = 'superseded'; step.lateResult = result.result }
      })
    } catch (error) { await this.update(runId, () => { if (current()) { step.state = 'outcome_unknown'; step.error = { code: error.code, message: error.message } } }) }
  }
  async persistPpt(runId, step) {
    const run = this.store.state.runs[runId], result = this.store.state.steps[step.id].result
    const projectId = step.resolvedInput.projectId
    const planRevision = step.planRevision
    const pageCount = run.taskSpec.pageCount
    const files = await this.adapters.ppt.files(projectId, result.version)
    if (run.state === 'cancelled' || run.planRevision !== planRevision) {
      await this.update(runId, () => { step.lateResult = result; step.state = 'superseded' }); return
    }
    try {
      const bytes = await readFile(files.path)
      if (bytes.subarray(0, 2).toString() !== 'PK' || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw new Error('PPTX 内容或版本哈希不一致')
      await promisify(execFile)('python3', [resolve(import.meta.dirname, '../verify-ppt.py'), files.path, String(pageCount), ...files.previewPaths], { timeout: 30000, maxBuffer: 65536 })
    } catch (error) { throw fail('OUTPUT_INVALID', `成品文件校验失败：${error.message}`) }
    const report = files.snapshot.report
    if (report?.phase !== 'final' || report.structural !== 'pass' || report.render !== 'pass' || report.slide_count !== pageCount || report.editable_pages !== report.slide_count || files.previewPaths.length !== report.slide_count) throw fail('OUTPUT_INVALID', 'PPT 全页/渲染/可编辑性验证未通过')
    await this.update(runId, () => {
      if (run.state === 'cancelled' || run.planRevision !== planRevision) { step.lateResult = result; step.state = 'superseded'; return }
      const publish = !run.pendingUserUpdates?.length && run.state === 'running'
      const existing = Object.values(this.store.state.artifacts).find(a => a.runId === runId && a.planRevision === planRevision && a.version === result.version && a.contentHash === result.sha256)
      if (existing?.status === 'ready') { delete step.publicationPending; return }
      if (existing && !publish) return
      if (existing) {
        existing.status = 'ready'; existing.actions = ['preview', 'download', 'edit', 'sources']; delete step.publicationPending
        this.store.emit(run.conversationId, 'message.committed', existing.id, { messageId: existing.id, type: 'artifact', sender: { type: 'agent', id: 'ppt' }, artifactRefs: [existing.id], runId, text: `${existing.title} · ${existing.version}` })
        return
      }
      const id = `art_${randomUUID()}`
      const artifact = { id, ownerId: run.ownerId, conversationId: run.conversationId, runId, kind: 'ppt', format: 'pptx', sourcePlugin: 'ppt', sourceEntityId: projectId, planRevision: run.planRevision, title: run.taskSpec.title || files.snapshot.meta.title, version: result.version, revision: Number(result.version.slice(1)), contentHash: result.sha256, path: files.path, previewPaths: files.previewPaths, sourceRefs: structuredClone(run.inputRefs), pageSources: files.snapshot.outline?.pages.map(p => ({ n: p.n, evidence: p.evidence })) || [], parentRefs: run.parentArtifactId ? [run.parentArtifactId] : [], status: publish ? 'ready' : 'candidate', actions: publish ? ['preview', 'download', 'edit', 'sources'] : [] }
      artifact.sourceSnapshot = structuredClone({ frozenMinutes: run.frozenMinutes, frozenPolicy: run.frozenPolicy, projectScope: run.projectScope, conditionTable: run.conditionTable, evidenceChecks: run.evidenceChecks })
      this.store.state.artifacts[id] = artifact
      if (!publish) { step.publicationPending = true; return }
      delete step.publicationPending
      this.store.emit(run.conversationId, 'message.committed', id, { messageId: id, type: 'artifact', sender: { type: 'agent', id: 'ppt' }, artifactRefs: [id], runId, text: `${artifact.title} · ${artifact.version}` })
    })
  }
  async action(runId, body) {
    const run = this.store.state.runs[runId]
    if (!run || run.ownerId !== this.store.state.ownerId) throw fail('SOURCE_NOT_FOUND', '任务不存在', 404)
    if (!['pause', 'resume', 'retry', 'cancel', 'increase_budget', 'replan', 'reconcile'].includes(body.action)) throw fail('INVALID_ACTION', '不支持的任务动作')
    const result = await this.store.transaction(() => deduplicate(this.store, `run-action:${runId}`, body, () => {
      const planEdit = body.action === 'replan' && body.expectedPlanRevision !== undefined
      if (planEdit ? body.expectedPlanRevision !== run.planRevision : body.expectedRevision !== run.revision) throw fail('VERSION_CONFLICT', planEdit ? '任务计划已变化，请重新打开计划表单' : '任务已变化，请刷新', 409)
      if (body.action === 'cancel') {
        if (TERMINAL.has(run.state)) throw fail('INVALID_ACTION', '任务已结束', 409)
        run.state = 'cancelled'
        for (const question of Object.values(this.store.state.questions)) if (question.runId === runId && question.state === 'open') { question.state = 'cancelled'; question.status = 'cancelled' }
        for (const step of Object.values(this.store.state.steps)) if (step.runId === runId && ['queued', 'waiting_user'].includes(step.state)) step.state = 'cancelled'
      }
      else if (body.action === 'pause') { if (TERMINAL.has(run.state)) throw fail('INVALID_ACTION', '任务已结束'); run.state = 'paused' }
      else if (body.action === 'reconcile') { /* Read external status without repeating a write. */ }
      else {
        if (TERMINAL.has(run.state)) throw fail('INVALID_ACTION', '任务已结束，请创建修改任务')
        if (run.blockedReason === 'OUTCOME_UNKNOWN' || this.store.state.outbox.some(o => o.runId === runId && o.state === 'outcome_unknown')) throw fail('OUTCOME_UNKNOWN', '投递结果不明，需要先对账；不会盲重发', 409)
        if (Object.values(this.store.state.steps).some(s => s.runId === runId && s.state === 'outcome_unknown')) throw fail('OUTCOME_UNKNOWN', '写操作结果不明，需要对账；不会盲重发', 409)
        if (body.action === 'replan') {
          if (run.kind !== 'business' && run.taskSpec.deliverable !== 'ppt') throw fail('INVALID_ACTION', '此任务不支持 PPT 重规划')
          const spec = body.taskSpec
          if (!spec || typeof spec.goal !== 'string' || !spec.goal.trim() || spec.goal.length > 16000 || !Number.isInteger(spec.pageCount) || spec.pageCount < 2 || spec.pageCount > 32 || spec.family !== undefined && (typeof spec.family !== 'string' || spec.family.length > 100)) throw fail('INVALID_TASK', '重规划需目标、2–32 页及有效模板')
          let nextScope, scopeChange
          if (spec.projectScope !== undefined) {
            if (run.taskSpec.kind !== 'policy') throw fail('INVALID_TASK', '只有政策任务支持项目知识库范围')
            nextScope = validateScope(spec.projectScope)
            const currentScope = run.taskSpec.projectScope || run.projectScope || {}
            const expanding = ['files', 'folders'].some(key => (nextScope[key] || []).some(value => !(currentScope[key] || []).includes(value)))
            if (expanding && body.scopeExpansionConfirmed !== true) throw fail('SCOPE_CONFIRMATION_REQUIRED', '扩大项目范围前请明确确认新增目录或文件', 409)
            scopeChange = { from: structuredClone(currentScope), to: structuredClone(nextScope), expansionConfirmed: expanding, confirmedAt: Date.now(), planRevision: run.planRevision + 1 }
          }
          this.coordinator.revisePlan(runId)
          Object.assign(run.taskSpec, { goal: spec.goal, pageCount: spec.pageCount, ...(spec.family ? { family: spec.family } : {}), modifyMode: 'regenerate' })
          if (nextScope) {
            run.taskSpec.projectScope = nextScope
            ;(run.scopeHistory ??= []).push(scopeChange)
          }
          delete run.sampleApproval; delete run.samplePreview
          for (const question of Object.values(this.store.state.questions)) if (question.runId === runId && question.state === 'open') { question.state = 'superseded'; question.status = 'superseded' }
          this.coordinator.createStep({ runId, adapterId: 'business', operation: 'business.prepare', input: {} })
          if (run.pendingUserUpdates?.length) { run.interruptionReturnState = 'ready'; this.adapters.business.nextUpdate(run) }
        }
        if (body.action === 'increase_budget') {
          for (const key of ['maxRequests','maxTurns','maxTokens','maxMinutes']) if (body.budget?.[key] !== undefined) { if (!Number.isInteger(body.budget[key]) || body.budget[key] <= run.budget[key] || body.budget[key] > 1000000) throw fail('INVALID_BUDGET', '预算必须显式增加'); run.budget[key] = body.budget[key] }
        }
        for (const step of this.steps(runId)) if (step.state === 'failed_retryable' || (step.state === 'interrupted' && step.effect === 'read')) {
          if (step.adapterId === 'ppt' && ['ppt.generate', 'ppt.render'].includes(step.operation) && ['failed', 'interrupted', 'cancelled'].includes(step.rawStatus) && step.externalJobId) {
            (step.previousJobs ??= []).push({ externalJobId: step.externalJobId, attempt: step.attempt, rawStatus: step.rawStatus })
            step.retryOf = step.externalJobId
            delete step.externalJobId
          }
          step.state = 'queued'
        }
        if (run.kind !== 'business' && run.activeSessionId) run.resumeRequested = true
        run.state = 'ready'; delete run.blockedReason
      }
      run.revision++; this.store.emit(run.conversationId, 'run.updated', runId, run); return run
    }))
    if (result.revision !== run.revision || result.state !== run.state) return result
    if (body.action === 'reconcile') {
      for (const step of Object.values(this.store.state.steps)) if (step.runId === runId && (['running','waiting_external','outcome_unknown','interrupted'].includes(step.state) || step.state === 'cancelled' && step.externalJobId && step.adapterId === 'ppt') && !this.controllers.has(step.id)) await this.reconcile(runId, step)
      if (run.kind !== 'business') {
        if (run.state === 'blocked' && run.blockedReason === 'STEP_RESULTS_REQUIRED') {
          if (this.steps(runId).every(s => ['succeeded', 'superseded'].includes(s.state))) {
            await this.update(runId, r => { r.state = 'ready'; r.resumeRequested = true; delete r.blockedReason })
            this.bridge?.schedule(runId)
          }
          return run
        }
        return this.bridge?.reconcileChat(runId) || run
      }
      const hasQuestion = Object.values(this.store.state.questions).some(q => q.runId === runId && q.state === 'open')
      if (['blocked', 'interrupted'].includes(run.state) && run.blockedReason !== 'BUDGET_EXHAUSTED' && !hasQuestion && !Object.values(this.store.state.steps).some(s => s.runId === runId && ['outcome_unknown', 'waiting_user'].includes(s.state))) { await this.update(runId, r => { r.state = 'ready'; delete r.blockedReason }); this.bridge?.schedule(runId) }
      return this.store.state.runs[runId]
    }
    if (['pause', 'cancel'].includes(body.action)) await this.bridge?.stopSession?.(run, body.action === 'pause', result.revision)
    if (body.action === 'cancel') {
      for (const step of Object.values(this.store.state.steps).filter(s => s.runId === runId && ['running', 'waiting_external', 'outcome_unknown'].includes(s.state))) {
        this.controllers.get(step.id)?.abort(fail('CANCELLED', '用户取消任务'))
        await this.cancelExternal(runId, step)
      }
    } else if (result.state === 'ready') this.bridge?.schedule(runId)
    return result
  }
  start() {
    this.timer = setInterval(() => {
      for (const run of Object.values(this.store.state.runs)) if ((run.kind === 'business' ? ['created', 'ready', 'running', 'interrupted'] : ['created', 'ready']).includes(run.state)) this.bridge?.schedule(run.id)
    }, 2000); this.timer.unref?.()
  }
  async close() { clearInterval(this.timer); for (const controller of this.controllers.values()) controller.abort(fail('INTERRUPTED', '插件停止')) }
}
