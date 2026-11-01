import { fail } from '../roles.js'
import { matchesTaskChanges } from '../runs/task-update.js'
import { validPptPlan } from '../runs/ppt-intent.js'
import { validPptRequirements, validPptEvidence, resolvePptEvidenceSelection, resolvePptRequirementSelection } from '../runs/ppt-admission.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && !!value.trim()
function validAnalysis(result, input) {
  if (!object(result)) return false
  if (input.responseFormat === 'ppt_plan') return validPptPlan(result)
  if (input.responseFormat === 'ppt_requirements') return input.requirementsMode === 'selection' ? !!resolvePptRequirementSelection(result, input.source) : validPptRequirements(result, input.source)
  if (input.responseFormat === 'ppt_evidence') return input.evidenceMode === 'selection' ? !!resolvePptEvidenceSelection(result, input.source) : validPptEvidence(result, input.source)
  if (input.responseFormat === 'task_update') {
    if (result.intent === 'clarify') return true
    if (!matchesTaskChanges(result, input.requestedChanges)) return false
    if (result.intent === 'new_task') return text(result.reason)
    if (!['supplement', 'replan'].includes(result.intent) || !text(result.reason) || !text(result.goal) || result.goal.length > 16000 || !Number.isInteger(result.pageCount) || result.pageCount < 2 || result.pageCount > 32 || typeof result.family !== 'string' || result.family.length > 100) return false
    return result.intent !== 'supplement' || result.goal === input.currentTask?.goal && result.pageCount === input.currentTask?.pageCount && result.family === (input.currentTask?.family || '')
  }
  if (input.responseFormat === 'contribution') return text(result.contribution)
  const quote = value => object(value) && text(value.quote) && text(value.location) && typeof input.source === 'string' && input.source.includes(value.quote)
  if (input.agentId === 'meeting') {
    return text(result.summary) && Array.isArray(result.quotes) && result.quotes.length > 0 && result.quotes.every(quote)
  }
  if (input.agentId === 'policy') {
    return text(result.query) && Array.isArray(result.conditions) && result.conditions.length > 0 && result.conditions.length <= 100
      && new Set(result.conditions.map(c => c?.id)).size === result.conditions.length
      && result.conditions.every(c => quote(c) && text(c.id) && text(c.condition) && object(c.evidence) && Object.values(c.evidence).every(v => typeof v === 'string'))
  }
  if (input.agentId === 'kb') {
    return Array.isArray(result.rows) && new Set(result.rows.map(r => r?.id)).size === result.rows.length
      && result.rows.every(r => object(r) && text(r.id) && ['满足', '不满足', '待确认'].includes(r.status) && typeof r.projectQuote === 'string' && typeof r.projectLocation === 'string' && typeof r.action === 'string')
  }
  return text(result.contribution)
}

export class AgentAdapter {
  constructor(bridge) { this.bridge = bridge }
  manifest() { return { operations: [{ name: 'agent.analyze', effect: 'create', timeoutMs: 120000 }] } }
  async invoke({ runId, stepId, input }) {
    // A new task delivers this directed message through its own retained outbox.
    if (input.taskUpdateDecision?.intent === 'new_task') return { contribution: '定向消息已交给独立任务处理。' }
    return this.bridge.beginContribution(runId, stepId, input)
  }
  async reconcile({ externalJobId, id, runId, attempt, resolvedInput, input }) {
    const rt = this.bridge.resolveRt(), scope = rt.workbenchOf(externalJobId)
    const run = this.bridge.store.state.runs[runId]
    if (!run || !scope || scope.stepId !== id || scope.sessionId !== externalJobId || scope.runId !== runId || scope.ownerId !== run.ownerId || scope.ownerId !== this.bridge.store.state.ownerId || scope.conversationId !== run.conversationId || scope.executionId !== `${id}:${attempt}`) throw fail('SOURCE_NOT_FOUND', '成员 Session 绑定不存在或不匹配', 404)
    const agent = await rt.resolveAgent(externalJobId)
    if (agent.status === 'running') return { state: 'waiting_external' }
    let text, receipt = false, boundary = false, queuedReceipt = false, execution = false, reason, turnReason, latestTurnReason
    const replies = []
    if (rt.eventsBackwards) for await (const event of rt.eventsBackwards(externalJobId, AbortSignal.timeout(20000), Infinity)) {
      if (event.type === 'agent/inbox/spliced' && event.data?.inserted?.some(m => m.source?.exchangeId === `${id}:${attempt}`)) queuedReceipt = true
      if (event.type.startsWith('tool/') || event.type.startsWith('llm/')) execution = true
      if (event.type === 'turn/end') { turnReason = event.data?.reason || { kind: 'interrupted' }; latestTurnReason ??= turnReason }
      if (event.type === 'turn/start') { turnReason = undefined; latestTurnReason ??= { kind: 'interrupted' } }
      if (event.type === 'user/message') {
        const source = event.data?.source
        // Producer context is not a new exchange; relay/recall and opaque inputs remain boundaries.
        const context = source && source.kind !== 'user' && source.exchangeId === undefined && (['instructions', 'catalog', 'snapshot', 'notice'].includes(source.form) || source.form === undefined && ['agent-instructions', 'runtime-context'].includes(source.kind))
        if (!context) { boundary = true; receipt = source?.exchangeId === `${id}:${attempt}`; break }
      }
      if (event.type === 'assistant/message') {
        replies.push(event)
        const candidate = (event.data?.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        if (text === undefined && candidate) { text = candidate; reason = turnReason || { kind: 'interrupted' } }
      }
    }
    if (!receipt) {
      const step = this.bridge.store.state.steps[id]
      if (rt.eventsBackwards && !boundary && !replies.length && !execution && latestTurnReason?.kind === 'blocked' && Number.isInteger(step?.planRevision) && step.planRevision !== run.planRevision) {
        const pending = [...(agent.inbox?.nextStep || []), ...(agent.inbox?.nextTurn || [])].filter(m => m.source?.exchangeId === `${id}:${attempt}`)
        // The old plan was blocked before its first user record; never discard uncertain executed work.
        if (pending.length === 1 && agent.inbox.remove(pending[0].id)) return { state: 'cancelled' }
        if (!pending.length && queuedReceipt) return { state: 'cancelled' }
      }
      return { state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN', message: '成员投递收据未确认，需要对账；不会盲重发' } }
    }
    for (const event of replies.reverse()) await this.bridge.recordReply(scope, { id: externalJobId }, event)
    const completion = latestTurnReason?.kind !== 'completed' ? latestTurnReason : text ? reason : latestTurnReason
    if (completion?.kind === 'error') return { state: 'failed_retryable', error: { code: completion.error?.code || 'MODEL_REQUEST_FAILED', message: completion.error?.message || '模型请求失败，请检查所选模型及请求配置后显式重试' } }
    if (completion?.kind === 'max-tokens') return { state: 'failed_retryable', error: { code: 'LLM_OUTPUT_TRUNCATED', message: '成员输出达到模型长度上限，不能采用部分输出；请调整模型或任务后显式重试' } }
    if (completion?.kind !== 'completed') return { state: 'failed_retryable', error: { code: 'INTERRUPTED', message: '成员轮次未完成，不能采用部分输出' } }
    if (!text || text.trim() === '[PASS]') return { state: 'failed_retryable', error: { code: 'NO_CONTRIBUTION', message: '成员未提供可验证输出' } }
    const analysis = resolvedInput || input || {}
    try {
      // Accept one complete member result frame; competing JSON/fences outside it remain ambiguous.
      const framed = analysis.responseFormat === 'ppt_requirements' && analysis.requirementsMode === 'selection' && text.trim().match(/^(?:[^`{}\[\]]*\r?\n)?```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n[^`{}\[\]]*)?$/)
      const result = JSON.parse(framed ? framed[1] : text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
      if (validAnalysis(result, analysis)) return { state: 'succeeded', result: analysis.responseFormat === 'ppt_requirements' && analysis.requirementsMode === 'selection' ? resolvePptRequirementSelection(result, analysis.source) : analysis.responseFormat === 'ppt_evidence' && analysis.evidenceMode === 'selection' ? resolvePptEvidenceSelection(result, analysis.source) : result }
    } catch { /* Conversational members may answer in plain text; business evidence remains typed. */ }
    if (analysis.responseFormat === 'task_update') return { state: 'succeeded', result: { intent: 'clarify', reason: '成员未返回足够且一致的分类依据，请由用户明确确认。' } }
    if (analysis.responseFormat === 'contribution') return { state: 'succeeded', result: { contribution: text.trim() } }
    return { state: 'failed_retryable', error: { code: 'INVALID_AGENT_OUTPUT', message: '成员输出结构或原文引文不符合要求，需重试或调整任务' } }
  }
  async cancel({ externalJobId }) {
    const agent = await this.bridge.resolveRt().resolveAgent(externalJobId)
    if (typeof agent.cancel !== 'function') throw fail('CANCEL_UNSUPPORTED', '宿主不支持中断此成员')
    await agent.cancel({ kind: 'user' }, { keepInbox: false })
  }
}
