import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deduplicate, fail, writableConversation } from './roles.js'
import { getToolRuntime } from './adapters/tool-dispatch.js'
import { validateScope } from './adapters/index.js'
import { validateInput } from './adapters/input.js'

const execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export class GeneralCapabilities {
  constructor({ store, ctx, bridge }) { Object.assign(this, { store, ctx, bridge }); this.io = Promise.resolve() }
  serialize(change) { const work = this.io.then(change); this.io = work.catch(() => {}); return work }
  task(scope) {
    this.authorize(scope)
    const run = this.store.state.runs[scope.runId]
    if (!run || run.ownerId !== scope.ownerId || run.conversationId !== scope.conversationId) throw fail('SOURCE_NOT_FOUND', '任务不可访问', 404)
    if (scope.stepId || run.state !== 'running' || run.kind === 'business') throw fail('DELEGATION_DENIED', '仅当前普通任务的主执行会话可调用此入口', 409)
    return run
  }
  async taskOperation(scope, { adapterId, operation, input, requestInput = input, stepId }, exec) {
    const run = this.task(scope), executor = this.bridge.business?.executor
    if (!executor) throw fail('CAPABILITY_UNAVAILABLE', '任务执行服务未启用', 503)
    const savedStep = await this.store.transaction(() => {
      this.task(scope)
      if (stepId) {
        const existing = this.store.state.steps[stepId]
        if (!existing || existing.runId !== run.id || existing.requestedBy !== scope.agentId || existing.planRevision !== run.planRevision) throw fail('SOURCE_NOT_FOUND', '步骤不属于当前任务', 404)
        return existing
      }
      const requestKey = digest(Buffer.from(JSON.stringify({ operation, input: requestInput })))
      const readOnly = executor.operation({ adapterId, operation }).effect === 'read'
      const key = `${scope.sessionId || scope.agentId}:${operation}:${readOnly && exec.callId || requestKey}`
      const saved = deduplicate(this.store, `task-tool:${run.id}`, { operation, input: requestInput, clientRequestId: digest(Buffer.from(key)) }, () => {
        const previous = adapterId === 'agent' && Object.values(this.store.state.steps).filter(s => s.runId === run.id && s.planRevision === run.planRevision && s.adapterId === 'agent' && s.requestedBy && s.state !== 'superseded').at(-1)
        const row = this.bridge.coordinator.createStep({ runId: run.id, adapterId, operation, input, dependsOn: previous ? [previous.id] : [] })
        row.requestedBy = scope.agentId
        return { id: row.id }
      })
      return this.store.state.steps[saved.id]
    })
    const step = this.store.state.steps[savedStep.id]
    if (this.bridge.coordinator.isStepRunnable(step, run) && !executor.controllers.has(step.id)) await executor.execute(run.id, step)
    const until = Date.now() + 20000
    while (['running', 'waiting_external'].includes(step.state) && !executor.controllers.has(step.id)) {
      exec.signal?.throwIfAborted()
      this.task(scope)
      await executor.reconcile(run.id, step)
      if (!['running', 'waiting_external'].includes(step.state) || Date.now() >= until) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    // The native tool boundary rejects undefined values, even in optional fields.
    const value = { stepId: step.id, state: step.state }
    if (step.state === 'succeeded') value.result = step.result
    if (step.error) value.error = step.error
    if (['queued', 'waiting_external'].includes(step.state)) value.message = '真实成员或业务尚未完成；用此 stepId 查询，不得假定完成或重新创建步骤。'
    return value
  }
  async delegate(scope, args, exec = {}) {
    const run = this.task(scope)
    if (scope.agentId !== 'chief') throw fail('DELEGATION_DENIED', '只有总 Agent 可协调当前群成员', 403)
    if (args.stepId) return this.taskOperation(scope, { stepId: args.stepId }, exec)
    const conversation = this.bridge.conversation(scope.conversationId)
    if (conversation.kind !== 'group' || args.agentId === 'chief' || !this.bridge.members(conversation.id).some(m => m.type === 'agent' && m.memberId === args.agentId)) throw fail('NOT_A_MEMBER', '只能调用当前群中的业务成员', 403)
    if (typeof args.goal !== 'string' || !args.goal.trim() || args.goal.length > 16000) throw fail('INVALID_TASK', '请填写成员任务')
    await this.store.transaction(() => {
      this.task(scope)
      if (this.bridge.roles.get(args.agentId).deletedAt && !this.store.state.runParticipants[`${run.id}:${args.agentId}`]) throw fail('AGENT_DELETED', '成员已删除，不能新增任务参与者', 409)
      run.participantAgentIds = [...new Set([...run.participantAgentIds, args.agentId])]
    })
    return this.taskOperation(scope, { adapterId: 'agent', operation: 'agent.analyze', requestInput: { agentId: args.agentId, goal: args.goal }, input: { agentId: args.agentId, responseFormat: 'contribution', goal: `${args.goal}\n只输出有效 JSON {"contribution":"你的结论与依据"}，不要代其他成员发言。`, source: JSON.stringify({ task: run.taskSpec.goal, history: this.store.messages(conversation.id).slice(-50).map(m => ({ sender: m.sender, text: m.text })), attachmentIds: run.attachmentIds, inputRefs: run.inputRefs }) } }, exec)
  }
  async capability(scope, args, exec = {}) {
    const run = this.task(scope), adapters = this.bridge.business.executor.adapters
    if (args.stepId) return this.taskOperation(scope, { stepId: args.stepId }, exec)
    const operations = Object.entries(adapters).filter(([id]) => !['agent', 'business'].includes(id)).flatMap(([adapterId, adapter]) => adapter.manifest().operations.filter(op => op.inputSchema).map(op => ({ ...op, adapterId })))
    if (!args.operation) return { operations }
    const op = operations.find(op => op.name === args.operation)
    if (!op || this.store.state.agents[op.adapterId]?.health !== 'ready') throw fail('CAPABILITY_UNAVAILABLE', '该业务操作未注册或当前不可用', 503)
    const input = structuredClone(args.input || {})
    validateInput(op.inputSchema, input)
    if (op.adapterId === 'kb' && op.name === 'kb.query') {
      input.scope = validateScope(input.scope)
      if (run.projectScope && JSON.stringify(run.projectScope) !== JSON.stringify(input.scope)) throw fail('SCOPE_CONFIRMATION_REQUIRED', '当前任务已有指定范围；扩大或更换范围需由用户创建新请求或明确确认', 409)
      await this.store.transaction(() => { this.task(scope); run.projectScope = structuredClone(input.scope); run.taskSpec.projectScope = structuredClone(input.scope) })
    }
    if (input.projectId && !Object.values(this.store.state.artifacts).some(a => a.ownerId === scope.ownerId && a.sourceEntityId === input.projectId && (a.conversationId === scope.conversationId || run.inputRefs?.some(ref => ref === a.id || ref?.id === a.id)))) throw fail('SOURCE_NOT_FOUND', 'PPT 项目不属于当前授权来源', 404)
    if (op.adapterId === 'policy') {
      if (op.name === 'policy.extract') {
        if (!run.policyCapabilityGate?.allowed || run.policyCapabilityGate.attachmentId !== input.attachmentId) throw fail('GATE_DENIED', '请先对同一附件明确完成政策公开性、来源、角色和模式门禁', 409)
        const attachment = this.store.state.attachments[input.attachmentId]
        await this.readAttachment(scope, input.attachmentId)
        input.path = attachment.path; input.publicConfirmed = true; delete input.attachmentId
      } else if (op.name === 'policy.preflight') {
        if (run.taskSpec.publicConfirmed !== true) {
          await this.bridge.askUser(scope.conversationId, '请明确确认政策材料公开性、来源、角色和模式；确认前不会读取政策正文。', { runId: run.id, field: 'policyGate', askedByAgentId: 'policy' })
          return { state: 'waiting_user', message: '请等待用户完成政策门禁表单，不得代用户确认。' }
        }
        Object.assign(input, Object.fromEntries(['publicConfirmed', 'source', 'role', 'mode'].map(key => [key, run.taskSpec[key]])))
        if (input.attachmentId) {
          await this.readAttachment(scope, input.attachmentId)
          input.filePaths = [this.store.state.attachments[input.attachmentId].path]; delete input.attachmentId
        }
      }
    }
    const result = await this.taskOperation(scope, { adapterId: op.adapterId, operation: op.name, input, requestInput: args.input || {} }, exec)
    if (op.name === 'policy.preflight' && result.state === 'succeeded') await this.store.transaction(() => { this.task(scope); run.policyCapabilityGate = { allowed: result.result?.allowed === true, attachmentId: args.input?.attachmentId } })
    return result
  }
  authorize(scope) {
    const conversation = this.store.state.conversations[scope.conversationId]
    if (!conversation || scope.ownerId !== this.store.state.ownerId || conversation.ownerId !== scope.ownerId) throw fail('SOURCE_NOT_FOUND', '材料不可访问', 404)
    const run = this.store.state.runs[scope.runId], step = this.store.state.steps[scope.stepId]
    if (conversation.deletedAt && !run?.startedAt) throw fail('CONVERSATION_DELETED', '会话已删除，请先恢复', 409)
    if (this.store.state.agents[scope.agentId]?.deletedAt && !(run?.startedAt && this.store.state.runParticipants[`${run.id}:${scope.agentId}`])) throw fail('AGENT_DELETED', '角色已删除，请先恢复', 409)
    if (run && (run.state === 'cancelled' || step && step.planRevision !== run.planRevision)) throw fail('INTERRUPTED', '此任务或步骤已停止')
    return conversation
  }
  async word(mode, source, target) {
    try { await execute('python3', [resolve(import.meta.dirname, 'word.py'), mode, source, target], { timeout: 30000, maxBuffer: 65536 }) }
    catch { throw fail('DOCUMENT_FAILED', 'DOCX 解析/生成失败，请检查文件或 Python3 环境', 422) }
  }
  createAttachment(body) {
    return this.serialize(async () => {
      const scope = { ownerId: this.store.state.ownerId, conversationId: body.conversationId }
      this.authorize(scope)
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255 || typeof body.dataBase64 !== 'string' || !body.dataBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64) || body.dataBase64.length % 4) throw fail('INVALID_ATTACHMENT', '无效附件名或 Base64 内容')
      const bytes = Buffer.from(body.dataBase64, 'base64')
      if (bytes.toString('base64') !== body.dataBase64) throw fail('INVALID_ATTACHMENT', '无效附件编码')
      if (bytes.length > 30 * 1024 * 1024) throw fail('INPUT_TOO_LARGE', '单个文件上限 30MB', 413)
      const ext = extname(body.name).toLowerCase()
      if (!['.txt', '.md', '.docx', '.pdf'].includes(ext)) throw fail('UNSUPPORTED_ATTACHMENT', '当前解析支持 TXT、Markdown、DOCX 和文本 PDF；旧 DOC/OCR 未启用', 415)
      const request = { ...body, dataBase64: undefined, contentHash: digest(bytes) }
      const attachment = await this.store.transaction(() => deduplicate(this.store, 'attachment', request, () => {
        writableConversation(this.store, body.conversationId)
        const id = `att_${randomUUID()}`
        const row = { id, ...scope, name: body.name, size: bytes.length, contentHash: digest(bytes), state: 'processing', version: digest(bytes), path: resolve(this.store.home, 'attachments', id + ext), textPath: resolve(this.store.home, 'attachments', id + '.parsed.txt') }
        this.store.state.attachments[id] = row
        return row
      }))
      const current = this.store.state.attachments[attachment.id]
      if (current.state === 'ready') return structuredClone(current)
      await mkdir(resolve(this.store.home, 'attachments'), { recursive: true, mode: 0o700 })
      try {
        await writeFile(attachment.path, bytes, { mode: 0o600 })
        if (ext === '.docx') await this.word('read', attachment.path, attachment.textPath)
        else if (ext === '.pdf') await execute('pdftotext', ['-layout', attachment.path, attachment.textPath], { timeout: 30000, maxBuffer: 65536 })
        else await writeFile(attachment.textPath, new TextDecoder('utf-8', { fatal: true }).decode(bytes), { mode: 0o600 })
        const text = await readFile(attachment.textPath, 'utf8')
        if (!text.trim() || text.length > 2_000_000) throw fail('ATTACHMENT_PARSE_FAILED', '无可用文本或正文超过 200 万字符')
        await this.store.transaction(() => { current.state = 'ready'; delete current.error; this.store.emit(body.conversationId, 'attachment.updated', current.id, { id: current.id, state: 'ready' }) })
      } catch (error) {
        await this.store.transaction(() => { current.state = 'failed'; current.error = error.message; this.store.emit(body.conversationId, 'attachment.updated', current.id, { id: current.id, state: 'failed', error: error.message }) })
      }
      return structuredClone(current)
    })
  }
  async readAttachment(scope, id) {
    this.authorize(scope)
    const artifact = this.store.state.artifacts[id]
    if (artifact) {
      const run = this.store.state.runs[scope.runId]
      const explicit = run?.ownerId === scope.ownerId && run.inputRefs?.some(ref => ref === id || ref?.id === id)
      if (artifact.ownerId !== scope.ownerId || (artifact.conversationId !== scope.conversationId && !explicit)) throw fail('SOURCE_NOT_FOUND', '成品不属于当前会话或授权任务', 404)
      if (artifact.status !== 'ready' || !artifact.textPath) throw fail('ARTIFACT_NOT_READY', '此成品没有可读取的正文', 409)
      return { id, title: artifact.title, version: artifact.version, text: await readFile(artifact.textPath, 'utf8') }
    }
    const att = this.store.state.attachments[id]
    const run = this.store.state.runs[scope.runId]
    const explicit = run?.attachmentIds?.includes(id) && run.ownerId === scope.ownerId
    if (!att || att.ownerId !== scope.ownerId || (att.conversationId !== scope.conversationId && !explicit)) throw fail('SOURCE_NOT_FOUND', '附件不属于当前会话或授权任务', 404)
    if (att.state !== 'ready') throw fail('ATTACHMENT_NOT_READY', '附件解析未完成', 409)
    return { id, name: att.name, version: att.version, text: await readFile(att.textPath, 'utf8') }
  }
  writeDocument(scope, body) {
    return this.serialize(async () => {
      this.authorize(scope)
      const modifying = this.store.state.runs[scope.runId]?.parentArtifactId
      if (modifying && body.parentArtifactId !== modifying) throw fail('VERSION_CONFLICT', '修改任务必须关联指定原文档版本', 409)
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2_000_000 || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || !['md', 'docx'].includes(body.format)) throw fail('INVALID_DOCUMENT', '文档需有标题、正文和 md/docx 格式')
      let parent
      if (body.parentArtifactId) {
        parent = this.store.state.artifacts[body.parentArtifactId]
        if (!parent || parent.ownerId !== scope.ownerId || parent.conversationId !== scope.conversationId) throw fail('SOURCE_NOT_FOUND', '旧版本不属于当前会话', 404)
      }
      const row = await this.store.transaction(() => deduplicate(this.store, `document:${scope.conversationId}`, body, () => {
        if (parent) {
          const family = parent.sourceEntityId || parent.id
          if (Object.values(this.store.state.artifacts).some(a => (a.sourceEntityId === family || a.id === family) && ['ready', 'processing'].includes(a.status) && a.revision > parent.revision)) throw fail('VERSION_CONFLICT', '文档已有新版本，请刷新后修改', 409)
          if (parent.status !== 'ready' || parent.kind !== 'document') throw fail('ARTIFACT_NOT_READY', '旧文档未准备完成', 409)
        }
        const id = `art_${randomUUID()}`, revision = (parent?.revision || 0) + 1
        const artifact = { id, ownerId: scope.ownerId, conversationId: scope.conversationId, runId: scope.runId, kind: 'document', sourcePlugin: 'general', title: body.title, format: body.format, revision, version: `v${revision}`, parentRefs: parent ? [parent.id] : [], sourceRefs: this.store.state.runs[scope.runId]?.inputRefs || [], status: 'processing', path: resolve(this.store.home, 'documents', `${id}.${body.format}`), textPath: resolve(this.store.home, 'documents', `${id}.txt`), actions: [] }
        this.store.state.artifacts[id] = artifact
        artifact.sourceEntityId = parent?.sourceEntityId || parent?.id || id
        return artifact
      }))
      const current = this.store.state.artifacts[row.id]
      if (current.status === 'ready') return structuredClone(current)
      await mkdir(resolve(this.store.home, 'documents'), { recursive: true, mode: 0o700 })
      try {
        await writeFile(row.textPath, body.text, { mode: 0o600 })
        if (body.format === 'docx') await this.word('write', row.textPath, row.path)
        else await writeFile(row.path, body.text, { mode: 0o600 })
        const contentHash = digest(await readFile(row.path))
        await this.store.transaction(() => {
          this.authorize(scope)
          current.status = 'ready'; current.contentHash = contentHash
          current.actions = ['preview', 'download'].map(action => ({ action, enabled: true, route: `/api/workbench-bot/v1/artifacts/${row.id}/content?representation=${action}` }))
          this.store.emit(scope.conversationId, 'message.committed', row.id, { messageId: row.id, type: 'artifact', sender: { type: 'agent', id: scope.agentId }, text: `${body.title} · ${current.version}`, artifactRefs: [row.id], runId: scope.runId })
        })
      } catch (error) { await this.store.transaction(() => { current.status = 'failed'; current.error = error.message }); throw error }
      return structuredClone(current)
    })
  }
  async webSearch(scope, query, exec) {
    this.authorize(scope)
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw fail('INVALID_QUERY', '搜索关键词需为 1–2000 字符')
    const runtime = getToolRuntime(this.ctx)
    let tool
    try { tool = runtime?.get('web_search') } catch { /* capability absent */ }
    let result
    if (tool?.execute) result = await tool.execute({ queries: [query] }, exec)
    else {
      // Web presets register the native tool per agent; the shared web service remains public.
      const web = this.ctx.get?.('web') || this.ctx.web
      if (!web?.search) throw fail('CAPABILITY_UNAVAILABLE', '联网搜索工具未启用', 503)
      result = await web.search({ query, maxResults: 8 }, exec.signal)
    }
    if (result == null || result?.ok === false) throw fail('CAPABILITY_UNAVAILABLE', '联网搜索失败，未获得可核查来源', 503)
    return result
  }
  registerTools() {
    const defs = [
      ['workbench_read_attachment', '读取当前会话或本任务明确授权的附件、Markdown/DOCX 成品正文与版本。', { id: { type: 'string' } }, ['id'], (scope, args) => this.readAttachment(scope, args.id)],
      ['workbench_web_search', '联网检索并返回真实来源；失败时不得编造链接。', { query: { type: 'string' } }, ['query'], (scope, args, exec) => this.webSearch(scope, args.query, exec)],
      ['workbench_write_document', '生成或修改真实 Markdown/DOCX 文档；旧版本保留。', { title: { type: 'string' }, text: { type: 'string' }, format: { type: 'string', enum: ['md', 'docx'] }, parentArtifactId: { type: 'string' } }, ['title', 'text', 'format'], (scope, args, exec) => this.writeDocument(scope, { ...args, clientRequestId: `${scope.runId}:${exec.callId || digest(Buffer.from(JSON.stringify(args)))}` })],
      ['workbench_business_task', '用户要求PPT时交接总Agent：按自然语言、授权上下文和附件正文判断材料充分性，按需直接生成、检索、协作或追问；不强制会议/政策流程。单能力问答使用workbench_capability，不得擅自添加PPT。', { goal: { type: 'string' }, project: { type: 'string' }, minutesId: { type: 'string' } }, ['goal'], (scope, args) => this.bridge.requestBusiness(scope, args)],
      ['workbench_delegate', '总 Agent 调用当前群的真实成员并获取结果。未完成时用返回的 stepId 查询，禁止代写成员结论；成员不能再次委派。', { agentId: { type: 'string' }, goal: { type: 'string' }, stepId: { type: 'string' } }, [], (scope, args, exec) => this.delegate(scope, args, exec)],
      ['workbench_capability', '调用已注册的单能力操作；不传 operation 获取操作及输入约束。知识库必须指定项目范围；政策抽取必须先通过同一附件的公开性门禁。用 stepId 查询在途结果，不要重发写操作。', { operation: { type: 'string' }, input: { type: 'object', additionalProperties: true }, stepId: { type: 'string' } }, [], (scope, args, exec) => this.capability(scope, args, exec)],
    ]
    for (const [name, description, properties, required, invoke] of defs) this.ctx.effect(() => this.ctx.tools.register({
      name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        const scope = this.bridge.resolveRt()?.workbenchOf(exec.agent?.id)
        if (!scope) throw fail('SCOPE_REQUIRED', '仅工作台授权会话可调用此工具', 403)
        this.authorize(scope)
        { const L = globalThis.__DSH_LIC__ && globalThis.__DSH_LIC__['workbench-bot']; if (L) { if (['workbench_read_attachment', 'workbench_web_search'].includes(name)) { const __s = await L.gate.state(); if (!__s.ready) throw new Error('本插件需要有效授权（workbench-bot）：请打开 /api/workbench-bot/v1/license/ui 激活或导入离线包'); } else { if (!(await L.gate.allow()).allowed) throw new Error('本插件需要有效授权（workbench-bot）：请打开 /api/workbench-bot/v1/license/ui 激活或导入离线包'); } } } /* WB-USE-BILL-V2 */
        return invoke(scope, args, exec)
      },
    }), `workbench-bot: ${name}`)
  }
}
