// workbench-bot 领域状态层（D1 合同实现）
// 持久化：$DSH_HOME/workbench-bot/state.json，复用 ds-bot 的 home-lock + revision 模式。
// 零第三方依赖：仅 node: 内置模块。
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { accountRunTime } from './runs/budget.js'

const EMPTY_STATE = () => ({
  version: 2,
  highWatermark: 0,
  revision: 0,
  agents: {},            // agentId -> AgentDefinition
  conversations: {},     // id -> Conversation
  memberships: {},       // id -> Membership
  sessionBindings: {},   // id -> SessionBinding
  runs: {},              // id -> Run
  steps: {},             // id -> Step
  questions: {},         // id -> Question
  artifacts: {},         // id -> Artifact
  attachments: {},       // id -> Attachment
  outbox: [],            // OutboxEntry[]
  events: [],            // EventRecord[]
  readCursors: {},       // conversationId -> ReadCursor
  conversationModels: {},// id -> ConversationModel
  contextSelections: {}, // id -> ContextSelection
  messagesByConversation: {},
  roleVersions: {},
  runParticipants: {},
  requests: {},
})

export function createStateHome(dshHome) {
  return path.join(dshHome || process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'workbench-bot')
}

// Keep references held by asynchronous deliveries valid when a concurrent write is rejected.
function checkpoint(value) {
  if (!value || typeof value !== 'object') return () => value
  const entries = Object.entries(value).map(([key, item]) => [key, checkpoint(item)])
  const length = Array.isArray(value) ? value.length : null
  return () => {
    for (const key of Object.keys(value)) delete value[key]
    if (length !== null) value.length = length
    for (const [key, restore] of entries) value[key] = restore()
    return value
  }
}

export class StateStore {
  constructor(home) {
    this.home = home
    this.statePath = path.join(home, 'state.json')
    this.state = EMPTY_STATE()
    this._writing = Promise.resolve()
    this._seq = 0
    this._transactions = Promise.resolve()
    this._error = null
    this._ensure = null
    this.listeners = new Set()
  }

  async ensure() {
    this._ensure ??= this._load()
    return this._ensure
  }

  async _load() {
    await fsp.mkdir(this.home, { recursive: true })
    try {
      const raw = await fsp.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (![1, 2].includes(parsed?.version)) throw Object.assign(new Error('Unsupported state version'), { code: 'SCHEMA_UNSUPPORTED' })
      this.state = { ...EMPTY_STATE(), ...parsed, version: 2 }
      // A restored process has no live execution interval; retain only committed active time.
      for (const run of Object.values(this.state.runs)) run.activeSince = null
      this._seq = Math.max(parsed.highWatermark || 0, ...this.state.events.map(e => e.seq || 0), 0)
      this.state.highWatermark = this._seq
      if (parsed.version === 1) {
        await fsp.copyFile(this.statePath, this.statePath + '.v1-backup', fsp.constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e })
        for (const e of this.state.events) if (e.type === 'message.committed') this._indexMessage(e)
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        this._error = Object.assign(new Error(`State unavailable: ${e.message}`), { code: e.code === 'SCHEMA_UNSUPPORTED' ? e.code : 'STATE_CORRUPT' })
        throw this._error
      }
    }
  }

  // 乐观锁：任何有效状态修改递增 revision
  bump() {
    this.state.revision += 1
  }

  // 追加事件并递增 seq
  emit(conversationId, type, entityId, payload, extra = {}) {
    this._seq += 1
    this.state.highWatermark = this._seq
    const event = {
      id: randomUUID(),
      ownerId: extra.ownerId || this.state.ownerId || '',
      conversationId,
      seq: this._seq,
      type,
      entityId,
      runId: extra.runId,
      revision: this.state.revision,
      payload: structuredClone(payload),
      occurredAt: Date.now(),
    }
    this.state.events.push(event)
    if (type === 'message.committed') this._indexMessage(event)
    // 事件日志上限，避免无限增长（保留最近 5000 条）
    if (this.state.events.length > 5000) {
      this.state.events = this.state.events.slice(-5000)
    }
    return this._seq
  }

  // 原子写（串行写锁）
  async save() {
    if (this._error) throw this._error
    const snapshot = JSON.stringify(this.state, null, 2)
    const write = this._writing.then(async () => {
      const tmp = this.statePath + '.tmp'
      await fsp.mkdir(this.home, { recursive: true })
      const file = await fsp.open(tmp, 'w', 0o600)
      try { await file.writeFile(snapshot, 'utf8'); await file.sync() } finally { await file.close() }
      await fsp.rename(tmp, this.statePath)
      const dir = await fsp.open(this.home, 'r')
      try { await dir.sync() } finally { await dir.close() }
      for (const notify of this.listeners) { try { notify() } catch { /* closed client */ } }
    })
    this._writing = write.catch(() => {})
    return write
  }

  highWatermark() {
    return this._seq
  }

  _indexMessage(event) {
    const rows = this.state.messagesByConversation[event.conversationId] ??= []
    if (rows.some(m => m.messageId === event.payload.messageId)) return
    rows.push({ ...event.payload, seq: event.seq, createdAt: event.occurredAt })
    const conv = this.state.conversations[event.conversationId]
    if (conv) { conv.lastSeq = event.seq; conv.updatedAt = event.occurredAt }
  }

  messages(conversationId) {
    return this.state.messagesByConversation[conversationId] || []
  }

  subscribe(notify) { this.listeners.add(notify); return () => this.listeners.delete(notify) }

  transaction(change) {
    const work = this._transactions.then(async () => {
      if (this._error) throw this._error
      const restore = checkpoint(this.state)
      const seq = this._seq
      try {
        for (const run of Object.values(this.state.runs)) accountRunTime(run)
        const result = await change()
        for (const run of Object.values(this.state.runs)) accountRunTime(run)
        this.bump()
        await this.save()
        return structuredClone(result)
      } catch (error) {
        this.state = restore()
        this._seq = seq
        throw error
      }
    })
    this._transactions = work.catch(() => {})
    return work
  }
}

// —— 默认五个私聊定义 ——
export const DEFAULT_AGENTS = [
  { agentId: 'chief',   capabilityId: 'chief',          title: '总 Agent',  adapterId: 'chief',   order: 0 },
  { agentId: 'meeting', capabilityId: 'cap:meeting',    title: '会议助手',  adapterId: 'meeting', order: 1 },
  { agentId: 'policy',  capabilityId: 'cap:policy-analysis', title: '政策解读', adapterId: 'policy', order: 2 },
  { agentId: 'kb',      capabilityId: 'kb',             title: '知识库',    adapterId: 'kb',      order: 3 },
  { agentId: 'ppt',     capabilityId: 'cap:huiwen-ppt', title: '汇文 PPT',  adapterId: 'ppt',     order: 4 },
]

export function ensureDefaultConversations(store, ownerId, { demo = process.env.WBB_DEMO_SEED === '1' } = {}) {
  if (!demo && (store.state.demo || Object.values(store.state.conversations).some(c => c.isDemo))) throw Object.assign(new Error('示例数据目录须以 WBB_DEMO_SEED=1 启动；真实 profile 请使用独立目录'), { code: 'DEMO_HOME_REQUIRES_DEMO_MODE' })
  if (store.state.ownerId && store.state.ownerId !== ownerId) throw Object.assign(new Error('State belongs to another owner; explicit migration required'), { code: 'OWNER_CONFLICT' })
  store.state.ownerId = ownerId
  for (const def of DEFAULT_AGENTS) {
    const existing = Object.values(store.state.conversations).find(
      c => c.ownerId === ownerId && c.isDefault && c.directAgentId === def.agentId
    )
    if (existing) continue
    // conversation id 含 ownerId，避免跨账号 id 冲突（A25 隔离要求）
    const id = `conv-${ownerId}-${def.agentId}`
    store.state.conversations[id] = {
      id,
      ownerId,
      kind: 'direct',
      title: def.title,
      isDefault: true,
      directAgentId: def.agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      lastSeq: 0,
      archived: false,
    }
    store.state.memberships[`${id}:${ownerId}`] = {
      conversationId: id, memberId: 'user', type: 'user', role: 'owner', joinedAt: Date.now(),
    }
    store.state.memberships[`${id}:${def.agentId}`] = {
      conversationId: id, memberId: def.agentId, type: 'agent', role: 'member', joinedAt: Date.now(),
    }
  }
  // demo 样例群夹具（A06/A28）：仅当 WBB_DEMO_SEED=1 时注入，实现 demo/真实 profile 分离
  if (demo) {
    store.state.demo = true
    const demoId = `conv-${ownerId}-demo-sample-group`
    if (!store.state.conversations[demoId]) {
      store.state.conversations[demoId] = {
        id: demoId,
        ownerId,
        kind: 'group',
        title: '研发周会 · PPT 汇报（示例）',
        isDefault: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
        lastSeq: 0,
        archived: false,
        isDemo: true,
      }
      store.state.memberships[`${demoId}:${ownerId}`] = { conversationId: demoId, memberId: 'user', type: 'user', role: 'owner', joinedAt: Date.now() }
      for (const aid of ['chief', 'meeting', 'kb', 'ppt']) {
        store.state.memberships[`${demoId}:${aid}`] = { conversationId: demoId, memberId: aid, type: 'agent', role: aid === 'chief' ? 'coordinator' : 'member', joinedAt: Date.now() }
      }
    }
    if (!store.messages(demoId).length) {
      const history = [
        ['user', '基于本次研发周会纪要，制作面向管理层的 8 页以内汇报。'],
        ['chief', '【公开示例】建立协作任务：会议助手固定纪要版本，知识库提供项目背景，汇文 PPT 组织页面。此历史用于演示，不是正在执行的真实任务。'],
        ['meeting', '【公开示例】纪要包含 4 项决策、6 项行动项、2 个风险；建议采用进展、问题、决策、行动的结构，并保留每项原文依据。'],
        ['kb', '【公开示例】仅检索选定项目的季度目标与风险处置材料；缺失依据明确标待确认，不扩大到其他项目。'],
        ['ppt', '【公开示例】整理大纲与样张后等待用户核对版本，再生成定稿、预览与可编辑文件。'],
        ['chief', '【公开示例】实际使用时，任务详情展示真实步骤、问题及产物。本示例不创建任务、文件或虚构进度。'],
      ]
      history.forEach(([id, text], i) => store.emit(demoId, 'message.committed', `demo-${demoId}-${i}`, { messageId: `demo-${demoId}-${i}`, text, isDemo: true, sender: { type: id === 'user' ? 'user' : 'agent', id: id === 'user' ? ownerId : id } }))
    }
  }
}
