import { randomUUID, createHash } from 'node:crypto'

export function fail(code, message, status = 422, details) {
  return Object.assign(new Error(message), { code, status, details })
}

export function writableConversation(store, id) {
  const conversation = store.state.conversations[id]
  if (!conversation || conversation.ownerId !== store.state.ownerId) throw fail('SOURCE_NOT_FOUND', '会话不存在', 404)
  if (conversation.deletedAt) throw fail('CONVERSATION_DELETED', '会话已删除，请先从回收站恢复', 409)
  return conversation
}

export function runAvailable(store, run, manual = false) {
  // A started task keeps its original authorization on crash recovery, never on a new user action.
  if (run.startedAt && !manual) return
  for (const id of new Set([run.conversationId, run.sourceConversationId].filter(Boolean))) writableConversation(store, id)
  const required = run.startedAt ? run.participantAgentIds || run.targetAgentIds || [] : new Set([...(run.participantAgentIds || []), ...(run.targetAgentIds || [])])
  for (const id of required) {
    const agent = store.state.agents[id]
    if (!agent || agent.ownerId && agent.ownerId !== store.state.ownerId) throw fail('SOURCE_NOT_FOUND', '角色不存在', 404)
    if (agent.deletedAt) throw fail('AGENT_DELETED', `${agent.title} 角色已删除，请先恢复`, 409)
    if (!run.startedAt && agent.lifecycle === 'archived') throw fail('AGENT_ARCHIVED', `${agent.title} 已归档，请先恢复`, 409)
    if (!run.startedAt) {
      const member = store.state.memberships[`${run.conversationId}:${id}`]
      if (member?.type !== 'agent' || member.conversationId !== run.conversationId || member.memberId !== id) throw fail('NOT_A_MEMBER', '任务成员已不在当前会话，请恢复成员后再继续', 403)
    }
  }
  if (!manual && run.deletedQueueBlocked) throw fail('RESUME_CONFIRMATION_REQUIRED', '恢复后须在任务卡确认继续', 409)
}

export function blockUnstarted(store, predicate, reason) {
  let count = 0
  for (const run of Object.values(store.state.runs)) {
    if (run.startedAt || ['cancelled', 'delivered', 'failed_terminal'].includes(run.state) || !predicate(run)) continue
    run.deletedQueueBlocked = true
    if (!['paused', 'waiting_user'].includes(run.state)) { run.state = 'blocked'; run.blockedReason = reason }
    run.revision++; count++
    store.emit(run.conversationId, 'run.updated', run.id, run)
  }
  return count
}

export function requestDigest(body) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
}

// Must run inside the state's write transaction so retries and first execution agree.
export function deduplicate(store, namespace, body, change) {
  const id = body.clientRequestId
  if (typeof id !== 'string' || !id.trim() || id.length > 160) throw fail('REQUEST_ID_REQUIRED', 'clientRequestId 必填')
  const key = `${store.state.ownerId}:${namespace}:${id}`
  const digest = requestDigest(body)
  const known = store.state.requests[key]
  if (known) {
    if (known.digest !== digest) throw fail('IDEMPOTENCY_CONFLICT', '此请求 ID 已用于不同内容', 409)
    return known.result
  }
  const result = change()
  store.state.requests[key] = { digest, result: structuredClone(result) }
  return result
}

function titleOf(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 40 || /[\r\n]/.test(title)) throw fail('INVALID_NAME', '名称须为单行 1–40 个字符')
  return title.trim()
}

function instructionsOf(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('ROLE_DESCRIPTION_REQUIRED', '职责说明必填')
  if (value.length > 32000) throw fail('INPUT_TOO_LARGE', '职责说明不得超过 32000 个字符')
  return value.trim()
}

export class RoleService {
  constructor(store, refreshHealth) { this.store = store; this.refreshHealth = refreshHealth }

  get(id) {
    const agent = this.store.state.agents[id]
    if (!agent || (agent.ownerId && agent.ownerId !== this.store.state.ownerId)) throw fail('SOURCE_NOT_FOUND', '角色不存在', 404)
    return agent
  }

  list(lifecycle = 'active', deleted = 'exclude') {
    return Object.values(this.store.state.agents).filter(a => (!a.ownerId || a.ownerId === this.store.state.ownerId) && (!lifecycle || (a.lifecycle || 'active') === lifecycle) && Boolean(a.deletedAt) === (deleted === 'only'))
  }

  uniqueTitle(title, except) {
    if (['user', 'all', 'everyone', 'agent', 'dsh agent'].includes(title.toLowerCase()) || Object.values(this.store.state.agents).some(a => a.agentId !== except && a.title?.toLowerCase() === title.toLowerCase())) throw fail('NAME_CONFLICT', '此名称已使用或为保留名称', 409)
  }

  create(body) {
    return this.store.transaction(() => deduplicate(this.store, 'role-create', body, () => {
      const title = titleOf(body.title)
      const instructions = instructionsOf(body.instructions)
      this.uniqueTitle(title)
      const now = Date.now()
      const agentId = `custom_${randomUUID()}`
      const agent = {
        agentId, botId: null, kind: 'custom', ownerId: this.store.state.ownerId,
        title, instructions, instructionsVersion: 1, revision: 1, lifecycle: 'active',
        health: 'unavailable', generalCapabilityProfile: 'general', createdAt: now, deletedAt: null, deletedBy: null,
      }
      this.store.state.agents[agentId] = agent
      this.store.state.roleVersions[`${agentId}:1`] = { ownerId: agent.ownerId, agentId, instructionsVersion: 1, instructions, createdAt: now }
      const conversation = this.createDirect(agent, title)
      this.store.emit(conversation.id, 'agent.created', agentId, agent)
      return { agent, conversation }
    }))
  }

  createDirect(agent, title) {
    const now = Date.now()
    const id = `conv_${randomUUID()}`
    const conversation = {
      id, ownerId: this.store.state.ownerId, kind: 'direct', directAgentId: agent.agentId,
      title: title || agent.title, isDefault: false, createdAt: now, updatedAt: now,
      revision: 1, lastSeq: 0, archived: false, deletedAt: null, deletedBy: null,
    }
    this.store.state.conversations[id] = conversation
    this.store.state.memberships[`${id}:user`] = { conversationId: id, memberId: this.store.state.ownerId, type: 'user', role: 'owner', joinedAt: now }
    this.store.state.memberships[`${id}:${agent.agentId}`] = { conversationId: id, memberId: agent.agentId, type: 'agent', role: 'member', joinedAt: now }
    return conversation
  }

  update(id, body) {
    return this.store.transaction(() => deduplicate(this.store, `role-edit:${id}`, body, () => {
      const agent = this.mutable(id, body.expectedRevision)
      if (agent.deletedAt) throw fail('AGENT_DELETED', '请先从回收站恢复角色', 409)
      if (body.title !== undefined) {
        const title = titleOf(body.title)
        this.uniqueTitle(title, id)
        agent.title = title
      }
      if (body.instructions !== undefined) {
        const instructions = instructionsOf(body.instructions)
        if (instructions !== agent.instructions) {
          agent.instructions = instructions
          agent.instructionsVersion++
          this.store.state.roleVersions[`${id}:${agent.instructionsVersion}`] = {
            ownerId: agent.ownerId, agentId: id, instructionsVersion: agent.instructionsVersion,
            instructions, createdAt: Date.now(),
          }
        }
      }
      agent.revision++
      this.store.emit(null, 'agent.updated', id, agent)
      return agent
    }))
  }

  mutable(id, revision) {
    const agent = this.get(id)
    if (agent.kind !== 'custom') throw fail('ROLE_NOT_CUSTOM', '只能编辑自定义角色')
    if (revision !== agent.revision) throw fail('VERSION_CONFLICT', '角色已更改，请刷新后再编辑', 409, { currentRevision: agent.revision })
    return agent
  }

  action(id, body) {
    return this.store.transaction(() => deduplicate(this.store, `role-action:${id}`, body, () => {
      const agent = this.mutable(id, body.expectedRevision)
      if (!['archive', 'restore', 'delete'].includes(body.action)) throw fail('INVALID_ACTION', '请选择归档、删除或恢复')
      if (body.action === 'delete') {
        if (agent.deletedAt) throw fail('AGENT_DELETED', '角色已删除', 409)
        agent.deletedAt = Date.now(); agent.deletedBy = this.store.state.ownerId
        blockUnstarted(this.store, run => run.participantAgentIds?.includes(id) || run.targetAgentIds?.includes(id), 'AGENT_DELETED')
      } else if (agent.deletedAt) {
        if (body.action !== 'restore') throw fail('AGENT_DELETED', '请先从回收站恢复角色', 409)
        agent.deletedAt = null; agent.deletedBy = null
      } else agent.lifecycle = body.action === 'archive' ? 'archived' : 'active'
      agent.revision++
      if (body.action === 'archive') for (const run of Object.values(this.store.state.runs)) {
        if (!run.startedAt && run.participantAgentIds?.includes(id)) {
          run.state = 'blocked'
          run.blockedReason = 'AGENT_ARCHIVED'
          run.revision++
        }
      }
      this.store.emit(null, 'agent.updated', id, agent)
      return agent
    }))
  }

  async admit(runId, agentIds) {
    await this.refreshHealth?.(agentIds.filter(id => !this.store.state.runParticipants[`${runId}:${id}`]))
    return this.store.transaction(() => {
      const run = this.store.state.runs[runId]
      if (run) runAvailable(this.store, run)
      const now = Date.now()
      const participants = [...new Set(agentIds)].map(id => {
        const key = `${runId}:${id}`
        const existing = this.store.state.runParticipants[key]
        if (existing) return existing
        const agent = this.get(id)
        if (agent.deletedAt) throw fail('AGENT_DELETED', `${agent.title} 角色已删除`, 409)
        if (agent.lifecycle === 'archived') throw fail('AGENT_ARCHIVED', `${agent.title} 已归档`, 409)
        if (agent.kind !== 'custom' && agent.health === 'unavailable') throw fail('CAPABILITY_UNAVAILABLE', `${agent.title} 当前不可用`, 409)
        const participant = {
          runId, agentId: id, ownerId: this.store.state.ownerId,
          instructionsVersion: agent.instructionsVersion || 1,
          instructionsSnapshot: agent.instructions || '', admittedAt: now,
        }
        this.store.state.runParticipants[key] = participant
        return participant
      })
      if (run) { run.startedAt ??= now; run.participantAgentIds = [...new Set([...(run.participantAgentIds || []), ...agentIds])] }
      return participants
    })
  }
}
