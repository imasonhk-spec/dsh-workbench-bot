import { createHash } from 'node:crypto'

const hash = text => createHash('sha256').update(text).digest('hex')

// Only committed, owner-scoped final results are evidence; history prose alone is not a receipt.
export function reusableContributions(state, run) {
  if (run.ownerId !== state.ownerId) return []
  const conversationId = run.sourceConversationId || run.conversationId
  if (state.conversations[conversationId]?.ownerId !== run.ownerId) return []
  const messages = state.messagesByConversation[conversationId] || []
  const trigger = messages.find(m => m.messageId === run.triggerMessageId && m.sender?.type === 'user' && m.sender.id === run.ownerId)
  if (!trigger) return []
  const results = []
  for (const prior of Object.values(state.runs)) {
    if (prior.id === run.id || prior.ownerId !== run.ownerId || prior.conversationId !== conversationId || prior.state !== 'delivered' || prior.cancelPending) continue
    const priorTrigger = messages.find(m => m.messageId === prior.triggerMessageId && m.sender?.type === 'user' && m.sender.id === run.ownerId)
    if (!priorTrigger || !Number.isInteger(priorTrigger.seq) || priorTrigger.seq >= trigger.seq || state.outbox.some(o => o.runId === prior.id && o.state !== 'acked')) continue
    const steps = Object.values(state.steps).filter(s => s.runId === prior.id)
    if (steps.some(s => s.invocationPending || !['succeeded', 'superseded', 'cancelled'].includes(s.state))) continue
    const add = (id, agentId, message, body, sessionId) => {
      const participant = state.runParticipants[`${prior.id}:${agentId}`]
      const agent = state.agents[agentId]
      const binding = state.sessionBindings[`${conversationId}:${agentId}`]
      if (!participant || participant.ownerId !== run.ownerId || participant.runId !== prior.id || participant.agentId !== agentId || agent?.ownerId !== run.ownerId) return
      if (!message || !Number.isInteger(message.seq) || message.seq <= priorTrigger.seq || message.seq >= trigger.seq || message.runId !== prior.id || message.sender?.type !== 'agent' || message.sender.id !== agentId || message.upstreamSessionId !== sessionId) return
      if (binding?.ownerId !== run.ownerId || binding.conversationId !== conversationId || binding.agentId !== agentId || !binding.upstreamSessionIds?.includes(sessionId)) return
      if (typeof body !== 'string' || !body.trim() || body.length > 16000) return
      results.push({ id, agentId, title: agent.title, runId: prior.id, messageId: message.messageId, sessionId, instructionsVersion: participant.instructionsVersion, instructionsSha256: hash(participant.instructionsSnapshot || ''), text: body, sha256: hash(body) })
    }
    for (const [agentId, output] of Object.entries(prior.textOutputs || {})) {
      const message = messages.find(m => m.messageId === output.answerId)
      if (!output.plain || message?.text !== output.text || !state.outbox.some(o => o.runId === prior.id && o.agentId === agentId && o.state === 'acked' && o.exchangeId === `${prior.id}:${agentId}`)) continue
      add(`message:${message.messageId}`, agentId, message, output.text, output.sessionId)
    }
    for (const step of steps) {
      if (step.state !== 'succeeded' || step.planRevision !== prior.planRevision || step.input?.responseFormat !== 'contribution' || !step.externalJobId || step.deliveryState !== 'acked') continue
      const message = messages.findLast(m => m.runId === prior.id && m.upstreamSessionId === step.externalJobId && m.text === step.responseText)
      let body = message?.text
      try { body = JSON.parse(body).contribution } catch { /* Plain member replies are supported by the existing adapter. */ }
      if (body === step.result?.contribution) add(`step:${step.id}`, step.input.agentId, message, body, step.externalJobId)
    }
  }
  return results
}
