import { fail } from './roles.js'

// Only Host plugin code receives this service; browsers and model tools cannot register adapters.
export class CapabilityRegistry {
  constructor({ store, bridge, adapters }) { Object.assign(this, { store, bridge, adapters }); this.registered = new Map() }
  async register(manifest, adapter) {
    if (!manifest || !/^[a-z][a-z0-9_-]{1,64}$/.test(manifest.agentId) || manifest.agentId === 'chief' || typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > 40 || !Array.isArray(manifest.operations) || !manifest.operations.length || typeof adapter?.invoke !== 'function' || typeof adapter?.health !== 'function') throw fail('INVALID_MANIFEST', '业务插件清单无效')
    const id = manifest.agentId
    if (this.store.state.agents[id]?.kind === 'custom' || this.registered.has(id)) throw fail('AGENT_ID_CONFLICT', '角色 ID 已使用', 409)
    for (const op of manifest.operations) if (!op.name?.startsWith(id + '.') || !['read','create','update'].includes(op.effect) || !Number.isInteger(op.timeoutMs) || op.timeoutMs < 1 || op.timeoutMs > 600000) throw fail('INVALID_MANIFEST', '操作需声明范围、效应和超时')
    const record = { manifest: structuredClone(manifest), adapter }
    this.registered.set(id, record); this.adapters[id] = adapter
    try {
      await this.store.transaction(() => {
        const agent = this.store.state.agents[id] ??= { agentId: id, ownerId: this.store.state.ownerId, kind: 'plugin', title: manifest.title, instructions: manifest.instructions || `使用 ${manifest.title} 的已注册业务操作，保留来源与真实状态。`, instructionsVersion: 1, revision: 1, lifecycle: 'active', health: 'unavailable' }
        agent.capabilityId = manifest.capabilityId; agent.adapterId = id
        this.store.emit(null, 'agent.updated', id, agent)
      })
      await this.bridge.ensureBot(id)
      await this.refresh(id)
    } catch (error) { await this.store.transaction(() => { this.store.state.agents[id].health = 'unavailable'; this.store.state.agents[id].healthReason = error.message }) }
    return async () => { if (this.registered.get(id) === record) await this.unregister(id) }
  }
  async refresh(id) {
    const record = this.registered.get(id)
    if (record?.pendingHealth) return record.pendingHealth
    const pending = this.probe(id, record)
    if (!record) return pending
    record.pendingHealth = pending
    try { return await pending }
    finally { if (record.pendingHealth === pending) delete record.pendingHealth }
  }
  async probe(id, record) {
    const health = record ? await record.adapter.health().catch(error => ({ status: 'unavailable', reason: error.message })) : { status: 'unavailable', reason: '业务插件已卸载' }
    await this.store.transaction(() => {
      // A removed/replaced registration owns its own readiness.
      if (this.registered.get(id) !== record) return
      const agent = this.store.state.agents[id]
      const status = health.status === 'ready' && agent?.botId ? 'ready' : 'unavailable'
      if (agent && (agent.health !== status || agent.healthReason !== health.reason)) { agent.health = status; agent.healthReason = health.reason; this.store.emit(null, 'agent.updated', id, agent) }
    })
    return health
  }
  async unregister(id) { this.registered.delete(id); delete this.adapters[id]; await this.refresh(id) }
  list() { return [...this.registered.values()].map(r => structuredClone(r.manifest)) }
}
