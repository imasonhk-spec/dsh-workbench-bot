// 知识库适配器 sidecar HTTP 直连：直接调用 dsh-raganything-kb 的 FastAPI sidecar
// 端点与 token 由当前账号的可信插件配置显式注入；复用原 task 协议，不依赖 ctx.tools。
//
// sidecar 协议（与 dsh-raganything-kb/lib/index.js 的 createSidecarManager 一致）：
//   GET    /health            -> { ok, initialized, uptime_s, tasks_running, ... }
//   GET    /status            -> sidecar 健康 + config + docs/tasks 计数
//   GET    /documents         -> { documents:[{id,status,title,...}], total }
//   POST   /tasks             -> body { op, params } => { task_id }
//   GET    /tasks/:id         -> 任务状态（轮询）
//   DELETE /tasks/:id         -> 取消任务
//   POST   /upload            -> multipart 文件上传（remote 模式 ingest 用）
//
// 鉴权：使用所注入 token 发送 Authorization: Bearer；不自动读取其他账号配置或回退共享端点。
import { adapterError } from './base.js'

// Account endpoint must be supplied by trusted plugin configuration.

export class KbSidecar {
  constructor({ baseUrl, fetchImpl, token } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '')
    this.fetch = fetchImpl || globalThis.fetch
    this.token = token || ''
    if (!this.fetch) throw adapterError('PLUGIN_UNAVAILABLE', 'no fetch available')
  }

  _headers(json = false) {
    const h = {}
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (json) h['content-type'] = 'application/json'
    return h
  }

  async _req(method, pathname, body) {
    if (!this.baseUrl) throw adapterError('PLUGIN_UNAVAILABLE', '未配置本账号知识库端点；不会回退公共 sidecar')
    let res
    try {
      res = await this.fetch(this.baseUrl + pathname, {
        method,
        headers: this._headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) {
      throw adapterError('PLUGIN_UNAVAILABLE', `sidecar 不可达: ${e.message}`)
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 2000) } }
    if (!res.ok) {
      const detail = data?.detail ?? data?.error ?? data?.raw
      const msg = typeof detail === 'string' ? detail : JSON.stringify(detail)
      throw adapterError('PLUGIN_UNAVAILABLE', `sidecar ${res.status}: ${msg}`)
    }
    return data
  }

  async health() {
    try {
      const r = await this._req('GET', '/health')
      return { status: r?.ok ? 'ready' : 'unavailable', detail: r }
    } catch (e) {
      return { status: 'unavailable', reason: e.message }
    }
  }

  async status() {
    return this._req('GET', '/status')
  }

  async documents() {
    return this._req('GET', '/documents')
  }

  /** 提交一个 task（op: query/ingest/ingest_text/delete_document），返回 task_id。 */
  async startTask(op, params) {
    const r = await this._req('POST', '/tasks', { op, params })
    return r?.task_id || r?.taskId
  }

  async getTask(taskId) {
    return this._req('GET', `/tasks/${taskId}`)
  }

  async cancelTask(taskId) {
    return this._req('DELETE', `/tasks/${taskId}`)
  }

  /** 同步等待一个 task 完成（轮询），返回最终 outcome。 */
  async waitTask(taskId, { timeoutMs = 120000, pollMs = 1200, signal } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) throw adapterError('CANCEL_UNSUPPORTED', 'aborted')
      const task = await this.getTask(taskId)
      // 参考 waitTask 的 outcomeFor：state done / error 即结束
      const state = task?.state ?? task?.status
      if (state === 'done' || state === 'succeeded' || state === 'complete') return task
      if (state === 'error' || state === 'failed') {
        throw adapterError('PLUGIN_UNAVAILABLE', `sidecar task failed: ${task?.error || JSON.stringify(task)}`)
      }
      if (Date.now() > deadline) {
        throw adapterError('TIMEOUT', `sidecar task ${taskId} timeout after ${timeoutMs}ms`)
      }
      await new Promise(r => setTimeout(r, pollMs))
    }
  }
}
