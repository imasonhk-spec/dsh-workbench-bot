// 会议适配器 JSON 文件直读：直接读取 dsh-meetai 落盘的数据文件，
// 复用其存储格式（与 index-huiwen.js 的 dataRoot()/loadMeetings()/loadMinutesIndex() 同源）。
//
// 为什么走文件直读而非进程内直驱
//   dsh-meetai 的 handle() 是模块内部函数（未 export），无 handlePackRequest 这类
//   进程内入口；其能力依赖 ctx.webServer 注册的 prefix 路由 + ctx.agents/agentDefaultModel
//   （纪要生成走本地 huiwen-lm 模型），这些都无法在适配器里直接构造。
//   但「读纪要/列会议」是纯读操作，数据已落盘为 JSON/MD 文件，直接读即可复用其格式，
//   且与 meetai 面板看到的数据完全一致（同一 DSH_HOME）。
//
// 数据布局（dataRoot = process.env.DSH_HOME || ~/.dsh，再拼 /meeting-assistant）：
//   meetings.json        -> [{ id, title, ... }]                     会议列表
//   minutes/index.json   -> { minutes_id: meta }                    纪要索引
//   minutes/<md_path>    -> 纪要正文（Markdown）
//   minutes/<transcript_path> -> { transcript }                    转写文本
import { readFile, realpath, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { adapterError, MANIFESTS } from './base.js'

function dataRoot(env = process.env) {
  const home = env.DSH_HOME || (os.homedir() ? path.join(os.homedir(), '.dsh') : process.cwd())
  return path.join(home, 'meeting-assistant')
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export class MeetingAdapter {
  constructor({ ctx, dataRoot: rootOverride, home, wordDocuments } = {}) {
    this.ctx = ctx
    this.wordDocuments = wordDocuments
    this.home = home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh")
    // 支持显式覆盖（测试用）；默认按 DSH_HOME 推导，与 meetai 的 dataRoot() 一致。
    this.root = rootOverride || (home ? path.join(home, 'meeting-assistant') : dataRoot())
  }

  manifest() { return { ...MANIFESTS.meeting, agentId: 'meeting' } }

  async health() {
    try {
      // 能力判定：meeting 读纪要是纯文件直读，只要数据根路径可解析即 ready。
      // 不依赖 settings.json 存在（首次使用前数据目录可能尚未创建）。
      // 优先看 meetai 的 meeting_create 工具是否已注册（表示业务插件已加载）。
      if (this.ctx && typeof this.ctx.get === 'function') {
        try {
          const tools = this.ctx.get('tools')
          if (tools && typeof tools.get === 'function' && typeof tools.get('meeting_create')?.execute === 'function') {
            return { status: 'ready', version: '1.0.0', detail: 'ctx.tools' }
          }
        } catch { /* tools 未注入 */ }
      }
      if (this.ctx) return { status: 'unavailable', version: 'unknown', reason: '会议插件未启用' }
      await access(path.join(this.root, 'minutes', 'index.json'))
      return { status: 'ready', version: '1.0.0', detail: 'file-direct' }
    } catch (e) {
      return { status: 'unavailable', version: 'unknown', reason: e.message }
    }
  }

  async _meetings() {
    return readJson(path.join(this.root, 'meetings.json'), [])
  }

  async _minutesIndex() {
    return readJson(path.join(this.root, 'minutes', 'index.json'), {})
  }

  async _minutesContent(rec) {
    if (rec?.word_content_artifact) {
      if (!this.wordDocuments) {
        const require = createRequire(import.meta.url)
        const base = path.dirname(require.resolve('dsh-meetai/package.json'))
        const { createWordDocuments } = await import(pathToFileURL(path.join(base, 'scripts/word-documents.mjs')).href)
        this.wordDocuments = createWordDocuments({ home: this.home })
      }
      return this.wordDocuments.readContent(rec.word_content_artifact)
    }
    if (rec?.md_path) {
      try {
        const root = await realpath(path.join(this.root, 'minutes'))
        const file = await realpath(path.resolve(root, rec.md_path))
        if (!file.startsWith(root + path.sep)) throw new Error('outside minutes')
        return await readFile(file, 'utf8')
      } catch { throw adapterError('SOURCE_NOT_FOUND', '纪要正文不可访问') }
    }
    throw adapterError('SOURCE_NOT_FOUND', '纪要没有正文')
  }

  async invoke({ operation, input }) {
    if (this.ctx && (await this.health()).status !== 'ready') throw adapterError('PLUGIN_UNAVAILABLE', '会议插件未启用')
    switch (operation) {
      case 'meeting.list_recent': {
        const meetings = await this._meetings()
        return { meetings }
      }
      case 'meeting.list_candidates': {
        // A17 消歧：列出候选纪要（按最近优先），供前端在用户说"刚才那份"时消歧选择。
        const idx = await this._minutesIndex()
        const rows = Object.values(idx).filter(r => r && typeof r === 'object')
        const candidates = rows
          .map(r => ({
            minutes_id: r.minutes_id,
            meeting_id: r.meeting_id || '',
            title: r.title || '',
            date: r.date || '',
            template_type: r.template_type || 'weekly',
            created_at: r.created_at || '',
          }))
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        return { candidates, count: candidates.length }
      }
      case 'meeting.read_minutes': {
        const key = input.artifactRef || input.minutesId || input.meetingId
        if (!key) throw adapterError('INPUT_AMBIGUOUS', 'read_minutes 需要 minutesId 或 meetingId')
        const idx = await this._minutesIndex()
        // 兼容 meetai 的 findMinutesByMeetingOrId：先按 minutes_id，再按 meeting_id。
        const rows = Object.values(idx).filter(r => r && typeof r === 'object')
        const byId = rows.find(r => r.minutes_id === key)
        let rec = byId
        if (!rec) {
          const forMeeting = rows.filter(r => r.meeting_id === key)
            .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          if (forMeeting.length > 1) throw adapterError('INPUT_AMBIGUOUS', '该会议有多个纪要版本，请明确选择 minutesId', { candidates: forMeeting.map(r => r.minutes_id) })
          rec = forMeeting[0] || null
        }
        if (!rec) throw adapterError('SOURCE_NOT_FOUND', `纪要不存在: ${key}`)
        const content = await this._minutesContent(rec)
        if (!content?.trim()) throw adapterError('SOURCE_NOT_FOUND', '纪要正文为空')
        return {
          minutes_id: rec.minutes_id,
          meeting_id: rec.meeting_id || '',
          title: rec.title || '',
          date: rec.date || '',
          template_type: rec.template_type || 'weekly',
          version: createHash('sha256').update(content).digest('hex'),
          created_at: rec.created_at || '',
          updated_at: rec.updated_at || '',
          action_items: Array.isArray(rec.action_items) ? rec.action_items : [],
          content,
        }
      }
      case 'meeting.extract_brief': {
        // 提取摘要：读纪要正文后由上层模型生成，此处仅返回正文供上层消费。
        const r = await this.invoke({ operation: 'meeting.read_minutes', input })
        return { content: r.content, title: r.title, minutes_id: r.minutes_id }
      }
      default:
        throw adapterError('PLUGIN_UNAVAILABLE', `unknown operation: ${operation}`)
    }
  }
}
