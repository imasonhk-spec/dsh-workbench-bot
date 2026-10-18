// Run Coordinator：任务图、状态机、幂等、恢复（设计文档 11 节落地）
import { randomUUID, createHash } from 'node:crypto'
import { fail } from '../roles.js'

export const RUN_STATES = [
  'created', 'planning', 'discussing', 'ready', 'running', 'waiting_user',
  'validating', 'delivered', 'paused', 'cancelled', 'blocked',
  'failed_retryable', 'failed_terminal', 'interrupted',
]

export const STEP_STATES = [
  'queued', 'running', 'waiting_external', 'succeeded', 'failed_retryable',
  'failed_terminal', 'cancel_requested', 'cancelled', 'interrupted',
  'outcome_unknown', 'superseded', 'waiting_user',
]

// 状态机转移表（design 11.1）
const TRANSITIONS = {
  created: ['planning'],
  planning: ['discussing', 'ready', 'waiting_user', 'failed_terminal'],
  discussing: ['ready', 'waiting_user', 'blocked'],
  ready: ['running', 'paused', 'cancelled', 'failed_retryable'],
  running: ['waiting_user', 'validating', 'paused', 'cancelled', 'blocked', 'failed_retryable', 'failed_terminal', 'interrupted'],
  waiting_user: ['ready', 'running', 'planning', 'cancelled'],
  validating: ['delivered', 'failed_retryable', 'failed_terminal'],
  delivered: [],
  paused: ['ready', 'running', 'cancelled'],
  cancelled: [],
  blocked: ['ready', 'running', 'failed_terminal'],
  failed_retryable: ['ready', 'running', 'failed_terminal'],
  failed_terminal: [],
  interrupted: ['ready', 'running', 'waiting_user', 'failed_terminal'],
}

export function idempotencyKey({ ownerId, runId, stepId, operation, inputDigest, planRevision }) {
  return createHash('sha256')
    .update([ownerId, runId, stepId, operation, inputDigest, planRevision].join('|'))
    .digest('hex')
}

export class RunCoordinator {
  constructor(store) {
    this.store = store
  }

  canTransition(from, to) {
    return (TRANSITIONS[from] || []).includes(to)
  }

  // 创建 Run
  createRun({ ownerId, conversationId, triggerMessageId, taskSpec, inputRefs, sourceConversationId, sourceMessageIds }) {
    if (ownerId !== this.store.state.ownerId) throw fail('SOURCE_NOT_FOUND', '任务账号不匹配', 404)
    if (triggerMessageId) {
      const known = Object.values(this.store.state.runs).find(r => r.ownerId === ownerId && r.conversationId === conversationId && r.triggerMessageId === triggerMessageId)
      if (known) return known
    }
    const id = `run_${randomUUID()}`
    const run = {
      id,
      ownerId,
      conversationId,
      triggerMessageId,
      sourceConversationId,
      sourceMessageIds: sourceMessageIds || [],
      taskSpec,
      inputRefs: inputRefs || [],
      state: 'created',
      createdAt: Date.now(), usage: { requests: 0, tokens: 0, turns: 0 },
      revision: 1,
      planRevision: 1,
      budget: { maxTurns: 12, maxRequests: 20, maxTokens: 64000, maxMinutes: 20 },
    }
    this.store.state.runs[id] = run
    this.store.bump()
    return run
  }

  // 转移状态（校验合法性）
  transition(runId, to, opts = {}) {
    const run = this.store.state.runs[runId]
    if (!run) throw new Error(`unknown run: ${runId}`)
    if (run.state === to) return run
    if (!this.canTransition(run.state, to)) {
      throw new Error(`invalid transition: ${run.state} -> ${to}`)
    }
    run.state = to
    if (opts.planRevision) run.planRevision = opts.planRevision
    if (opts.blockedReason !== undefined) run.blockedReason = opts.blockedReason
    run.revision += 1
    this.store.bump()
    return run
  }

  // 创建 Step
  createStep({ runId, operation, adapterId, dependsOn = [], input, planRevision }) {
    const id = `step_${randomUUID().slice(0, 8)}`
    const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const run = this.store.state.runs[runId]
    const key = idempotencyKey({
      ownerId: run.ownerId, runId, stepId: id, operation, inputDigest,
      planRevision: planRevision ?? run.planRevision,
    })
    const step = {
      id, runId, operation, adapterId, dependsOn,
      input: input || {}, inputDigest, idempotencyKey: key, planRevision: planRevision ?? run.planRevision,
      state: 'queued', attempt: 0, resultRefs: [],
    }
    this.store.state.steps[id] = step
    return step
  }

  // 更新 Step 状态（保留外部 job id）
  updateStep(stepId, state, opts = {}) {
    const step = this.store.state.steps[stepId]
    if (!step) throw new Error(`unknown step: ${stepId}`)
    step.state = state
    if (opts.externalJobId) step.externalJobId = opts.externalJobId
    if (opts.resultRefs) step.resultRefs = opts.resultRefs
    if (opts.rawStatus) step.rawStatus = opts.rawStatus
    step.attempt = (step.attempt || 0) + (state === 'running' ? 1 : 0)
    this.store.bump()
    return step
  }

  // 依赖就绪判断：所有 dependsOn 均 succeeded 且 planRevision 有效
  isStepRunnable(step, run) {
    if (step.state !== 'queued') return false
    if (step.planRevision !== undefined && step.planRevision !== run.planRevision) return false
    return step.dependsOn.every(id => {
      const dep = this.store.state.steps[id]
      return dep && dep.state === 'succeeded'
    })
  }

  // 计划变更：递增 planRevision，撤销未开始步骤
  revisePlan(runId) {
    const run = this.store.state.runs[runId]
    run.planRevision += 1
    for (const step of Object.values(this.store.state.steps)) {
      if (step.runId === runId && ['queued', 'waiting_user'].includes(step.state)) {
        step.state = 'superseded'
      }
    }
    this.store.bump()
    return run
  }

  // —— A22 版本锁 ——
  // 同一源实体（如 PPT projectId）的 artifact 版本链：取当前最高 revision。
  artifactHeadRevision(ownerId, sourceEntityId) {
    if (!sourceEntityId) return 0
    let max = 0
    for (const a of Object.values(this.store.state.artifacts)) {
      if (a.ownerId === ownerId && a.sourceEntityId === sourceEntityId) {
        const rev = a.revision || 0
        if (rev > max) max = rev
      }
    }
    return max
  }

  // 乐观锁校验：expectedRevision 与当前头版本不一致则冲突。
  checkRevisionLock({ ownerId, sourceEntityId, expectedRevision }) {
    if (expectedRevision == null || !sourceEntityId) return { ok: true, head: null }
    const head = this.artifactHeadRevision(ownerId, sourceEntityId)
    if (head !== Number(expectedRevision)) {
      const e = new Error(`revision conflict: expected ${expectedRevision}, current ${head}`)
      e.code = 'REVISION_CONFLICT'
      e.details = { expectedRevision, head }
      throw e
    }
    return { ok: true, head }
  }
}
