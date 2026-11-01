// 业务适配器统一接口与 manifest 定义（设计文档 7.2 节落地）
// 每个适配器负责：discover（manifest）、health、invoke（调用业务操作）。

export const ERROR_CODES = [
  'PLUGIN_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'SOURCE_NOT_FOUND', 'INPUT_AMBIGUOUS',
  'VERSION_CONFLICT', 'TIMEOUT', 'CANCEL_UNSUPPORTED', 'EVIDENCE_REJECTED', 'OUTCOME_UNKNOWN',
]

export function adapterError(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

// 各适配器的 manifest（operations 声明，对应 design 7.3 标准操作组）
export const MANIFESTS = {
  meeting: {
    agentId: 'meeting',
    adapterVersion: '1.0.0',
    title: '会议助手',
    capabilityId: 'cap:meeting',
    operations: [
      { name: 'meeting.read_minutes', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'meeting.list_recent', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'meeting.list_candidates', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'meeting.extract_brief', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 60000 },
    ],
  },
  policy: {
    agentId: 'policy',
    adapterVersion: '1.0.0',
    title: '政策解读',
    capabilityId: 'cap:policy-analysis',
    operations: [
      { name: 'policy.preflight', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'policy.extract', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 60000 },
      { name: 'policy.evidence_check', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 60000 },
    ],
  },
  kb: {
    agentId: 'kb',
    adapterVersion: '1.0.0',
    title: '知识库',
    capabilityId: 'kb',
    operations: [
      { name: 'kb.query', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'kb.list_docs', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'kb.ingest', effect: 'create', idempotency: 'dedup-key', supportsCancel: false, recovery: 'reconcile_job', timeoutMs: 120000 },
    ],
  },
  ppt: {
    agentId: 'ppt',
    adapterVersion: '1.0.0',
    title: '汇文 PPT',
    capabilityId: 'cap:huiwen-ppt',
    operations: [
      { name: 'ppt.list_templates', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'ppt.create_project', effect: 'create', idempotency: 'dedup-key', supportsCancel: false, recovery: 'reconcile_job', timeoutMs: 60000 },
      { name: 'ppt.generate', effect: 'create', idempotency: 'dedup-key', supportsCancel: true, recovery: 'reconcile_job', timeoutMs: 300000 },
      { name: 'ppt.render', effect: 'create', idempotency: 'dedup-key', supportsCancel: true, recovery: 'reconcile_job', timeoutMs: 300000 },
      { name: 'ppt.status', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
      { name: 'ppt.export', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 },
    ],
  },
}

// Trusted operation effects drive timeout, recovery and write intent persistence.
for (const name of ['configure', 'add_material', 'generate_outline', 'select_style', 'confirm_samples', 'patch']) MANIFESTS.ppt.operations.push({ name: `ppt.${name}`, effect: 'update', idempotency: 'reconcile', supportsCancel: false, recovery: 'reconcile_job', timeoutMs: 300000 })
MANIFESTS.ppt.operations.push({ name: 'ppt.revise', effect: 'update', idempotency: 'reconcile', supportsCancel: false, recovery: 'reconcile_job', timeoutMs: 600000 })
MANIFESTS.ppt.operations.push({ name: 'ppt.snapshot', effect: 'read', idempotency: 'intrinsic', supportsCancel: false, recovery: 'retry_read', timeoutMs: 30000 })
MANIFESTS.ppt.operations.find(o => o.name === 'ppt.export').effect = 'update'

// Public model inputs use attachment IDs, never host file paths or caller-supplied identities.
const string = { type: 'string', minLength: 1, maxLength: 2000 }
const fields = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const scope = fields(Object.fromEntries(['files', 'folders'].map(key => [key, { type: 'array', items: { type: 'string', minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 100 }])))
const inputs = {
  'meeting.list_recent': fields({}), 'meeting.list_candidates': fields({}),
  'meeting.read_minutes': fields({ minutesId: string }, ['minutesId']),
  'meeting.extract_brief': fields({ minutesId: string }, ['minutesId']),
  'kb.query': fields({ query: string, scope, mode: string }, ['query', 'scope']),
  'kb.list_docs': fields({}),
  'policy.preflight': fields({ attachmentId: string }),
  'policy.extract': fields({ attachmentId: string }, ['attachmentId']),
  'ppt.list_templates': fields({}),
  'ppt.snapshot': fields({ projectId: string }, ['projectId']),
}
for (const manifest of Object.values(MANIFESTS)) for (const op of manifest.operations) if (inputs[op.name]) op.inputSchema = inputs[op.name]

// HTTP 适配器基类：内部通过 fetch 调用插件后端 HTTP API
export class HttpAdapter {
  constructor({ baseUrl, fetchImpl }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetch = fetchImpl || globalThis.fetch
    if (!this.fetch) throw adapterError('PLUGIN_UNAVAILABLE', 'no fetch available')
  }

  async _req(method, pathname, body) {
    const url = this.baseUrl + pathname
    const opts = { method, headers: { 'content-type': 'application/json' } }
    if (body !== undefined) opts.body = JSON.stringify(body)
    let res
    try {
      res = await this.fetch(url, opts)
    } catch (e) {
      throw adapterError('PLUGIN_UNAVAILABLE', `request failed: ${e.message}`)
    }
    let data = null
    try { data = await res.json() } catch { /* 非 JSON */ }
    if (!res.ok) {
      const code = data?.error?.code || (res.status === 409 ? 'VERSION_CONFLICT' : 'PLUGIN_UNAVAILABLE')
      throw adapterError(code, data?.error?.message || `HTTP ${res.status}`, { status: res.status, details: data?.error?.details })
    }
    return data
  }

  async health() {
    try {
      await this._req('GET', '/status')
      return { status: 'ready', version: '1.0.0' }
    } catch (e) {
      return { status: 'unavailable', version: 'unknown', reason: e.message }
    }
  }
}
