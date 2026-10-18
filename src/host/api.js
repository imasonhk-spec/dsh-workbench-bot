import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fail, deduplicate } from './roles.js'

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > max) throw fail('INPUT_TOO_LARGE', '请求体超过上限', 413); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw fail('INVALID_JSON', '请求 JSON 格式无效', 400) }
}

export function createApi({ store, bridge, coordinator = bridge.coordinator, adapters = {}, executor, general, ctx = bridge.ctx, enabled = true }) {
  const owned = (map, id) => {
    const entity = store.state[map][id]
    if (!entity || entity.ownerId !== store.state.ownerId) throw fail('SOURCE_NOT_FOUND', '对象不存在', 404)
    return entity
  }
  const publicArtifact = artifact => {
    const { path, textPath, previewPath, previewPaths, sourceSnapshot, ...metadata } = artifact
    metadata.previewPageCount = previewPaths?.length || 0
    return metadata
  }
  const describe = conversation => ({
    ...conversation, lastMessage: store.messages(conversation.id).at(-1) || null, models: Object.fromEntries(Object.entries(store.state.conversationModels).filter(([k]) => k.startsWith(conversation.id + ':')).map(([k, v]) => [k.slice(conversation.id.length + 1), v])), members: bridge.members(conversation.id),
    memberCount: bridge.members(conversation.id).length,
    unread: store.messages(conversation.id).filter(m => m.seq > (store.state.readCursors[conversation.id]?.lastReadSeq || 0) && m.sender?.type !== 'user').length,
    waitingUser: Object.values(store.state.questions).some(q => q.conversationId === conversation.id && q.state === 'open'),
  })

  async function handle(req, res, pathname, method) {
    try {
      const connection = ctx?.get?.('connection')
      if (!connection?.requestRejection) throw fail('AUTH_UNAVAILABLE', '认证服务不可用', 503)
      const rejection = connection.requestRejection({ headers: req.headers || {} })
      if (rejection !== undefined) throw fail(rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', '请求未通过认证', rejection === 401 ? 401 : rejection === 403 ? 403 : 503)
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin
        if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') throw fail('FORBIDDEN', '写请求须来自同源页面', 403)
      }
      const url = new URL(req.url || pathname, 'http://localhost')
      const seg = pathname.replace(/^\/api\/workbench-bot\/v1\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
      const query = url.searchParams
      if (!enabled) {
        if (method === 'GET' && (!seg.length || seg[0] === 'bootstrap')) return sendJson(res, { enabled: false })
        throw fail('WORKBENCH_DISABLED', 'Bot 协作已停用', 404)
      }
      if (method === 'GET' && (!seg.length || seg[0] === 'bootstrap')) return sendJson(res, {
        enabled: true,
        ownerId: store.state.ownerId,
        demo: Boolean(store.state.demo),
        agents: Object.values(store.state.agents).filter(a => !a.ownerId || a.ownerId === store.state.ownerId),
        conversations: Object.values(store.state.conversations).filter(c => c.ownerId === store.state.ownerId).map(describe),
        capabilities: Object.values(adapters).map(a => a.manifest()), highWatermark: store.highWatermark(),
      })
      if (seg[0] === 'agents') {
        if (seg.length === 1 && method === 'GET') return sendJson(res, { items: bridge.roles.list(query.get('lifecycle') || 'active').filter(a => !query.get('q') || a.title.includes(query.get('q'))), nextCursor: null })
        if (seg.length === 1 && method === 'POST') return sendJson(res, await bridge.createAgent(await readBody(req)), 201)
        if (seg.length === 2 && method === 'GET') return sendJson(res, bridge.roles.get(seg[1]))
        if (seg.length === 2 && method === 'PATCH') return sendJson(res, await bridge.roles.update(seg[1], await readBody(req)))
        if (seg[2] === 'actions' && method === 'POST') return sendJson(res, await bridge.roles.action(seg[1], await readBody(req)))
      }
      if (seg[0] === 'conversations') {
        if (seg.length === 1 && method === 'GET') {
          let rows = Object.values(store.state.conversations).filter(c => c.ownerId === store.state.ownerId)
          if (query.get('q')) rows = rows.filter(c => (c.title + (store.messages(c.id).at(-1)?.text || '')).includes(query.get('q')))
          rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
          const offset = Math.max(0, Number(query.get('cursor')) || 0), limit = Math.min(50, Math.max(1, Number(query.get('limit')) || 50))
          return sendJson(res, { items: rows.slice(offset, offset + limit).map(describe), nextCursor: rows.length > offset + limit ? String(offset + limit) : null })
        }
        if (seg.length === 1 && method === 'POST') return sendJson(res, await bridge.createConversation(await readBody(req)), 201)
        const conv = bridge.conversation(seg[1])
        if (seg.length === 2 && method === 'PATCH') return sendJson(res, await bridge.updateConversation(conv.id, await readBody(req)))
        if (seg.length === 2 && method === 'GET') return sendJson(res, { conversation: describe(conv), members: bridge.members(conv.id), activeRuns: Object.values(store.state.runs).filter(r => r.conversationId === conv.id && !['delivered', 'cancelled', 'failed_terminal'].includes(r.state)) })
        if (seg[2] === 'messages' && method === 'GET') {
          const limit = Math.min(50, Math.max(1, Number(query.get('limit')) || 50))
          const rows = (await bridge.listMessages(conv.id)).filter(m => !query.get('beforeSeq') || m.seq < Number(query.get('beforeSeq')))
          const items = rows.slice(-limit)
          return sendJson(res, { items, nextBeforeSeq: rows.length > limit ? items[0].seq : null, lastSeq: conv.lastSeq })
        }
        if (seg[2] === 'messages' && method === 'POST') {
          const body = await readBody(req)
          try { return sendJson(res, await bridge.sendMessage(conv.id, body), 202) }
          catch (error) {
            // Permissions may change after acceptance; consult the durable receipt before releasing a draft.
            const receipt = await store.transaction(() => {
              const request = { ...body, clientRequestId: body.clientMessageId }
              if (store.state.requests[`${store.state.ownerId}:message:${conv.id}:${body.clientMessageId}`]) return deduplicate(store, `message:${conv.id}`, request, () => {})
              if (error.status < 500) error.details = { ...error.details, notAccepted: true }
            })
            if (receipt) return sendJson(res, receipt, 202)
            throw error
          }
        }
        if (seg[2] === 'read' && method === 'PUT') {
          const body = await readBody(req)
          if (!Number.isInteger(body.lastReadSeq) || body.lastReadSeq < 0) throw fail('INVALID_CURSOR', '读取游标无效')
          const cursor = await store.transaction(() => store.state.readCursors[conv.id] = { ownerId: conv.ownerId, lastReadSeq: Math.max(store.state.readCursors[conv.id]?.lastReadSeq || 0, Math.min(conv.lastSeq, body.lastReadSeq)) })
          return sendJson(res, cursor)
        }
        if (seg[2] === 'model' && method === 'PUT') {
          const body = await readBody(req), aid = body.agentId || conv.directAgentId || 'chief'
          if (!bridge.members(conv.id).some(m => m.type === 'agent' && m.memberId === aid)) throw fail('NOT_A_MEMBER', '角色不属于当前会话', 403)
          const ref = body.model ?? `${body.providerId}/${body.modelId}`
          if (ref !== '' && !(await bridge.listModels()).items.some(m => m.ref === ref)) throw fail('MODEL_UNAVAILABLE', '模型不可用', 409)
          const model = await store.transaction(() => {
            const key = `${conv.id}:${aid}`, previous = store.state.conversationModels[key]
            if (body.expectedRevision !== (previous?.revision || 0)) throw fail('VERSION_CONFLICT', '模型配置已变化', 409)
            return store.state.conversationModels[key] = { model: ref, revision: (previous?.revision || 0) + 1 }
          })
          return sendJson(res, { ...model, effectiveFromNextTurn: true })
        }
      }
      if (seg[0] === 'contexts' && method === 'POST') {
        const body = await readBody(req), conv = bridge.conversation(body.sourceConversationId)
        if (!Array.isArray(body.sourceMessageIds) || !body.sourceMessageIds.length || body.sourceMessageIds.length > 20) throw fail('INVALID_CONTEXT', '请选择 1–20 条源消息')
        const messages = body.sourceMessageIds.map(id => {
          const message = store.messages(conv.id).find(m => m.messageId === id)
          if (!message) throw fail('SOURCE_NOT_FOUND', '源消息不存在', 404)
          return { conversationId: conv.id, messageId: id, text: message.text, sender: message.sender, seq: message.seq }
        })
        const selection = await store.transaction(() => deduplicate(store, 'context-selection', body, () => {
          const id = `context_${randomUUID()}`
          return store.state.contextSelections[id] = { id, ownerId: conv.ownerId, sourceConversationId: conv.id, messages, createdAt: Date.now(), revision: 1 }
        }))
        return sendJson(res, selection, 201)
      }
      if (seg[0] === 'attachments') {
        if (seg.length === 1 && method === 'POST') {
          if (!general) throw fail('CAPABILITY_UNAVAILABLE', '附件服务未启用', 503)
          const row = await general.createAttachment(await readBody(req, 42 * 1024 * 1024))
          const { path, textPath, ...metadata } = row
          return sendJson(res, metadata, 201)
        }
        if (seg.length === 2 && method === 'GET') { const row = owned('attachments', seg[1]); bridge.conversation(row.conversationId); const { path, textPath, ...metadata } = row; return sendJson(res, metadata) }
      }
      if (seg[0] === 'runs') {
        if (seg.length === 1 && method === 'GET') return sendJson(res, { items: Object.values(store.state.runs).filter(r => r.ownerId === store.state.ownerId && (!query.get('conversationId') || (r.conversationId === query.get('conversationId') || r.sourceConversationId === query.get('conversationId')))) })
        if (seg.length === 1 && method === 'POST') {
          const body = await readBody(req); bridge.conversation(body.conversationId)
          const accepted = await bridge.sendMessage(body.conversationId, { text: body.taskSpec?.goal || body.goal, taskSpec: body.taskSpec, attachmentIds: body.attachmentIds || [], artifactRefs: body.artifactRefs || [], clientMessageId: body.clientRequestId })
          return sendJson(res, accepted, 202)
        }
        const run = owned('runs', seg[1])
        if (seg.length === 2 && method === 'GET') return sendJson(res, { run, steps: Object.values(store.state.steps).filter(s => s.runId === run.id), questions: Object.values(store.state.questions).filter(q => q.runId === run.id), artifacts: Object.values(store.state.artifacts).filter(a => a.runId === run.id).map(publicArtifact) })
        if (seg[2] === 'samples' && seg[3] === 'content' && method === 'GET') {
          const preview = run.samplePreview
          if (!preview || query.get('version') !== preview.version) throw fail('VERSION_CONFLICT', '样张版本不匹配', 409)
          const files = await adapters.ppt.files(preview.projectId, preview.version)
          const page = Number(query.get('page') || 1)
          if (!Number.isInteger(page) || page < 1 || page > files.previewPaths.length) throw fail('SOURCE_NOT_FOUND', '样张页不存在', 404)
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          return res.end(await readFile(files.previewPaths[page - 1]))
        }
        if (seg[2] === 'actions' && method === 'POST') {
          if (!executor?.action) throw fail('CAPABILITY_UNAVAILABLE', '任务控制服务未启用', 503)
          return sendJson(res, await executor.action(run.id, await readBody(req)), 202)
        }
      }
      if (seg[0] === 'artifacts') {
        const artifact = owned('artifacts', seg[1])
        if (seg.length === 2 && method === 'GET') return sendJson(res, publicArtifact(artifact))
        if (seg[2] === 'sources' && method === 'GET') {
          if (artifact.status !== 'ready') throw fail('ARTIFACT_NOT_READY', '候选结果尚未确认为当前计划成品', 409)
          const run = owned('runs', artifact.runId)
          const sources = artifact.sourceSnapshot || run
          // Text-only sample revisions retain the preceding validated evidence in the same Run.
          const latest = Object.values(store.state.steps).filter(s => s.runId === run.id && (s.planRevision ?? 1) <= (artifact.planRevision ?? 1) && s.operation === 'business.evidence' && s.state === 'succeeded').sort((a, b) => b.planRevision - a.planRevision)[0]
          const evidence = sources.conditionTable ? [{ rows: sources.conditionTable, evidenceChecks: sources.evidenceChecks }] : latest ? [latest.result] : []
          return sendJson(res, { sourceRefs: artifact.sourceRefs || [], pageSources: artifact.pageSources || [], parentRefs: artifact.parentRefs || [], contentHash: artifact.contentHash, frozenMinutes: sources.frozenMinutes, frozenPolicy: sources.frozenPolicy, projectScope: sources.projectScope, conditionTable: sources.conditionTable, evidenceChecks: sources.evidenceChecks, evidence })
        }
        if (seg[2] === 'editor' && method === 'GET') {
          if (artifact.kind !== 'ppt' || artifact.status !== 'ready') throw fail('ARTIFACT_NOT_READY', '此成品没有 PPT 编辑项目', 409)
          if (!adapters.ppt) throw fail('PLUGIN_UNAVAILABLE', '汇文 PPT 插件未启用', 503)
          const snapshot = await adapters.ppt.invoke({ operation: 'ppt.snapshot', input: { projectId: artifact.sourceEntityId }, ownerId: store.state.ownerId })
          if (snapshot.meta?.version !== artifact.version || snapshot.studio_state?.current_sha256 !== artifact.contentHash) throw fail('VERSION_CONFLICT', '原 PPT 项目已有新版本，请从最新成品打开编辑', 409)
          return sendJson(res, { projectId: artifact.sourceEntityId, title: artifact.title, version: artifact.version })
        }
        if (seg[2] === 'actions' && method === 'POST') {
          const body = await readBody(req)
          if (body.action !== 'modify' || typeof body.goal !== 'string' || !body.goal.trim() || body.goal.length > 32000) throw fail('INVALID_ACTION', '修改需有明确要求')
          if (artifact.status !== 'ready') throw fail('ARTIFACT_NOT_READY', '成品尚未准备完成', 409)
          if (body.expectedVersion !== artifact.version) throw fail('VERSION_CONFLICT', '文件版本不匹配，请刷新', 409)
          if (artifact.kind === 'ppt') {
            if (!bridge.business?.modify) throw fail('CAPABILITY_UNAVAILABLE', 'PPT 修改服务未启用', 503)
            return sendJson(res, await bridge.business.modify(artifact, body), 202)
          }
          return sendJson(res, await bridge.sendMessage(artifact.conversationId, { text: body.goal, artifactRefs: [artifact.id], modifyArtifactId: artifact.id, clientMessageId: body.clientRequestId }), 202)
        }
        if (seg[2] === 'content' && method === 'GET') {
          if (query.get('version') && query.get('version') !== artifact.version) throw fail('VERSION_CONFLICT', '文件版本不匹配', 409)
          if (artifact.status !== 'ready') throw fail('ARTIFACT_NOT_READY', '成品尚未准备完成', 409)
          const preview = query.get('representation') === 'preview'
          const page = Number(query.get('page') || 1)
          if (preview && artifact.kind === 'ppt' && (!Number.isInteger(page) || page < 1 || page > artifact.previewPaths?.length)) throw fail('SOURCE_NOT_FOUND', '预览页不存在', 404)
          const file = preview ? artifact.kind === 'ppt' ? artifact.previewPaths[page - 1] : artifact.textPath || artifact.previewPath : artifact.path
          if (!file) throw fail('SOURCE_NOT_FOUND', '此版本文件不可用', 404)
          const bytes = await readFile(file)
          const type = preview ? artifact.kind === 'ppt' ? 'image/png' : artifact.previewType || 'text/plain; charset=utf-8' : artifact.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : artifact.kind === 'ppt' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'text/markdown; charset=utf-8'
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.title + '.' + (artifact.format || 'pptx'))}`, 'content-security-policy': "default-src 'none'; sandbox" })
          return res.end(bytes)
        }
      }
      if (seg[0] === 'questions' && method === 'GET') return sendJson(res, { items: Object.values(store.state.questions).filter(q => q.state === 'open' && store.state.conversations[q.conversationId]?.ownerId === store.state.ownerId) })
      if (seg[0] === 'models' && method === 'GET') return sendJson(res, await bridge.listModels())
      if (seg[0] === 'ppt' && seg[1] === 'templates' && method === 'GET') {
        if (!adapters.ppt) throw fail('PLUGIN_UNAVAILABLE', '汇文 PPT 插件未启用', 503)
        return sendJson(res, await adapters.ppt.invoke({ operation: 'ppt.list_templates', input: {}, ownerId: store.state.ownerId }))
      }
      if (seg[0] === 'meetings' && seg[1] === 'candidates' && method === 'GET') return sendJson(res, await adapters.meeting.invoke({ operation: 'meeting.list_candidates', input: {}, ownerId: store.state.ownerId }))
      if (seg[0] === 'health' && method === 'GET') {
        const health = {}
        for (const [id, adapter] of Object.entries(adapters)) { const h = adapter.health ? await adapter.health() : { status: 'ready', version: 'internal' }; health[id] = { status: h.status, version: h.version, reason: h.reason } }
        return sendJson(res, health)
      }
      if (seg[0] === 'events' && method === 'GET') {
        let cursor = Math.max(0, Number(query.get('after') || req.headers['last-event-id']) || 0)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        const publish = () => {
          const events = store.state.events
          if (events.length && cursor < events[0].seq - 1) { cursor = store.highWatermark(); res.write(`event: reset\nid: ${cursor}\ndata: {}\n\n`); return }
          for (const event of events) if (event.seq > cursor && event.ownerId === store.state.ownerId) { res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.seq }
        }
        res.flushHeaders?.()
        const dispose = store.subscribe(publish)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref?.()
        res.on('close', () => { dispose(); clearInterval(heartbeat) })
        publish()
        return
      }
      throw fail('NOT_FOUND', '接口不存在', 404)
    } catch (error) {
      return sendJson(res, { error: { code: error.code || 'INTERNAL_ERROR', message: error.message, retryable: (error.status || 500) >= 500, requestId: randomUUID(), details: error.details } }, error.status || 500)
    }
  }
  return { handle }
}
