window.__ModuleLoader__.load({
  id: '@local/dsh-workbench-bot',
  factory(require) {
    const React = require('react'), primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement, { useState, useEffect, useRef } = React
    // 气泡轻量 Markdown：标题/列表/表格/代码块/引用/加粗等，全部生成 React 节点，
    // 不注入 HTML，消息内容无法污染页面。
    const mdInline = s => {
      const out = []
      const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g
      let i = 0, m
      while ((m = re.exec(s))) {
        if (m.index > i) out.push(s.slice(i, m.index))
        const t = m[0], key = 'i' + m.index
        if (t[0] === '`') out.push(h('code', { key }, t.slice(1, -1)))
        else if (t.startsWith('**') || t.startsWith('__')) out.push(h('strong', { key }, mdInline(t.slice(2, -2))))
        else if (t[0] === '*') out.push(h('em', { key }, mdInline(t.slice(1, -1))))
        else {
          const link = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
          out.push(link && /^https?:\/\//.test(link[2]) ? h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1]) : t)
        }
        i = m.index + t.length
      }
      if (i < s.length) out.push(s.slice(i))
      return out
    }
    const mdBlocks = value => {
      const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let i = 0, n = 0
      const add = node => out.push(node)
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i++; continue }
        if (/^\s*```/.test(line)) {
          const buf = []
          i++
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++])
          i++
          add(h('pre', { key: 'b' + n++ }, h('code', {}, buf.join('\n'))))
          continue
        }
        if (/^\s*([-*_])[ \t]*\1[ \t]*\1[\s*_-]*$/.test(line)) { add(h('hr', { key: 'b' + n++ })); i++; continue }
        const head = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
        if (head) {
          add(h('h' + Math.min(head[1].length + 3, 6), { key: 'b' + n++ }, mdInline(head[2].replace(/\s*#+\s*$/, ''))))
          i++
          continue
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
          const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
          const head2 = cells(line)
          i += 2
          const rows = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
          add(h('table', { key: 'b' + n++ },
            h('thead', {}, h('tr', {}, head2.map((c, x) => h('th', { key: x }, mdInline(c))))),
            h('tbody', {}, rows.map((r, y) => h('tr', { key: y }, r.map((c, x) => h('td', { key: x }, mdInline(c))))))))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
          add(h('blockquote', { key: 'b' + n++ }, mdBlocks(buf.join('\n'))))
          continue
        }
        const item = line.match(/^\s*([-*+]|\d+[.)])\s+/)
        if (item) {
          const ordered = /\d/.test(item[1])
          const items = []
          while (i < lines.length) {
            const next = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
            if (!next) {
              if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += '\n' + lines[i].trim(); i++; continue }
              break
            }
            items.push(next[2]); i++
          }
          add(h(ordered ? 'ol' : 'ul', { key: 'b' + n++ }, items.map((t, x) => h('li', { key: x }, mdInline(t)))))
          continue
        }
        const buf = []
        while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++])
        if (!buf.length) buf.push(lines[i++])
        add(h('p', { key: 'b' + n++ }, mdInline(buf.join('\n'))))
      }
      return out
    }
    const mdPlain = value => String(value ?? '')
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const BASE = '/api/workbench-bot/v1', uid = () => crypto.randomUUID()
    const state = { agents: [], conversations: [], messages: {}, attachments: {}, scrollPositions: {}, drafts: {}, pending: {}, uploads: {}, runs: {}, models: [], selected: null, ownerId: null, error: '', online: false, loading: false }
    const STEP_LABELS = { queued:'等待执行', running:'执行中', waiting_external:'等待业务结果', waiting_user:'等待回答', succeeded:'已完成', failed_retryable:'失败可重试', failed_terminal:'失败', outcome_unknown:'结果待对账', cancelled:'已取消', cancel_requested:'已请求取消', superseded:'已被新计划替代', interrupted:'已中断' }
    const OP_LABELS = { 'agent.analyze':'成员分析', 'business.prepare':'准备任务与来源', 'business.review_samples':'等待样张确认', 'meeting.read_minutes':'读取指定纪要', 'policy.preflight':'政策业务门禁', 'policy.extract':'提取政策原文', 'policy.evidence_check':'核对政策证据', 'kb.query':'检索指定项目', 'ppt.create_project':'建立 PPT 项目', 'ppt.configure':'配置页数与目标', 'ppt.add_material':'固定来源材料', 'ppt.generate_outline':'生成大纲', 'ppt.select_style':'选择模板', 'ppt.generate':'生成并检查页面', 'ppt.confirm_samples':'确认指定版本样张', 'ppt.export':'导出并验证成品', 'ppt.revise':'按要求修订文字', 'ppt.patch':'更新页面对象', 'ppt.render':'渲染检查' }
    const RUN_LABELS = { created:'已创建', planning:'规划中', discussing:'讨论中', ready:'待执行', running:'执行中', waiting_user:'等待回答', validating:'验证成品', delivered:'已交付', blocked:'已阻塞', paused:'已暂停', failed_retryable:'失败，可重试', failed_terminal:'失败', interrupted:'已中断', cancelled:'已取消' }
    const runStatus = run => run.cancelPending ? '正在停止…' : Object.hasOwn(RUN_LABELS, run.state) ? RUN_LABELS[run.state] : '状态待核实'
    const listeners = new Set()
    let openMain = () => {}, mount, events, timer, stopped = false, refreshPromise, refreshResult, finishRefresh, refreshAgain = false, initialized = false, eventTimer = null, pollTimer = null, eventRetry = 0, lastSeq = 0
    const notify = () => { for (const fn of listeners) fn() }
    let layoutControl = null
    function selectMainPanel(id) { try { layoutControl?.selectPanel(id) } catch (error) { state.error = error.message; notify() } }
    // 最大化后（主面板模式）右上角 × 还原为悬浮窗：先切回会话主面板，再重新弹出悬浮窗。
    function restoreFloating() {
      try { selectMainPanel(null) } catch (error) { state.error = error.message; notify() }
      setSidebarCollapsed(false)
      try { window.dispatchEvent(new CustomEvent('workbench-bot:open')) } catch { /* 无 DOM 环境 */ }
    }

    function sidebarFrame() { return document.querySelector('[data-rightbar-col]')?.parentElement || null }
    function nativeNavVisible() {
      return [...document.querySelectorAll('nav[class*="panelList"]')].some(nav => nav.getBoundingClientRect().height > 0)
    }
    let sidebarOwned = false
    // Collapse only a sidebar this shell actually shows (the classic Agent navigation);
    // a team view that hides the panel list is left to its owner. Expanding is allowed
    // only for a collapse this plugin caused, so a user's own collapse preference survives.
    function setSidebarCollapsed(collapsed) {
      if (!layoutControl) return
      const frame = sidebarFrame()
      if (!frame) return
      const isCollapsed = frame.hasAttribute('data-sidebar-collapsed')
      if (collapsed) {
        if (isCollapsed || !nativeNavVisible()) return
        try { layoutControl.toggleSidebar(); sidebarOwned = true } catch { /* layout service unavailable */ }
        return
      }
      if (!sidebarOwned || !isCollapsed) { sidebarOwned = false; return }
      sidebarOwned = false
      try { layoutControl.toggleSidebar() } catch { /* layout service unavailable */ }
    }
    const storageKey = () => `dsh.workbench.bot.v2:${state.ownerId}`
    function persist() { if (state.ownerId) try { localStorage.setItem(storageKey(), JSON.stringify({ selected: state.selected, drafts: state.drafts, pending: state.pending })) } catch { /* quota leaves in-memory drafts intact */ } }
    function changed() { persist(); notify() }
    async function api(method, path, body) {
      const response = await fetch(BASE + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error?.message || `HTTP ${response.status}`), result.error)
      if (!state.online) { state.online = true; notify() }
      return result
    }
    function mergeMessages(id, items) {
      const all = new Map((state.messages[id]?.items || []).map(m => [m.messageId, m]))
      for (const m of items) all.set(m.messageId, m)
      return [...all.values()].sort((a, b) => a.seq - b.seq)
    }
    async function loadConversation(id) {
      if (!id) return
      const [messages, runs] = await Promise.all([api('GET', `/conversations/${id}/messages`), api('GET', `/runs?conversationId=${encodeURIComponent(id)}`)])
      const prior = state.messages[id]
      state.messages[id] = { ...messages, items: mergeMessages(id, messages.items), nextBeforeSeq: prior?.loadedOlder ? prior.nextBeforeSeq : messages.nextBeforeSeq, loadedOlder: prior?.loadedOlder }
      const details = await Promise.all(runs.items.map(r => api('GET', `/runs/${r.id}`)))
      state.runs[id] = details
      const attachmentIds = [...new Set([...(state.drafts[id]?.attachmentIds || []), ...messages.items.flatMap(m => m.attachmentIds || [])])]
      await Promise.allSettled(attachmentIds.filter(aid => !state.attachments[aid]).map(async aid => { state.attachments[aid] = await api('GET', `/attachments/${aid}`) }))
      if (state.selected === id && document.visibilityState === 'visible') await api('PUT', `/conversations/${id}/read`, { lastReadSeq: messages.lastSeq })
      notify()
    }
    function connectEvents() {
      // EventSource 只在「网络错误」时自动重连；收到 4xx/5xx（如服务重启瞬间的 502）会永久失败，
      // 原实现只在初始化时 new 一次，之后一直停在「连接恢复中」。这里自行重建 + 退避 + 兜底轮询。
      try { events?.close() } catch { /* 旧连接已失效 */ }
      events = new EventSource(`${BASE}/events?after=${lastSeq || 0}`)
      events.onopen = () => {
        eventRetry = 0
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        if (!state.online) { state.online = true; notify() }
      }
      events.onerror = () => {
        try { events?.close() } catch { /* 忽略 */ }
        const wait = Math.min(15000, 1000 * (2 ** Math.min(eventRetry++, 4)))
        clearTimeout(eventTimer)
        eventTimer = setTimeout(() => {
          if (stopped) return
          refresh().catch(() => {}).finally(() => { if (!stopped) connectEvents() })
        }, wait)
        // SSE 断开期间仍用轮询保底，界面照常刷新
        if (!pollTimer) pollTimer = setInterval(() => { if (!stopped) refresh().catch(() => {}) }, 8000)
        notify()
      }
      const schedule = () => { clearTimeout(timer); timer = setTimeout(() => refresh().catch(() => {}), 150) }
      events.onmessage = e => { if (e.lastEventId) lastSeq = Number(e.lastEventId) || lastSeq; schedule() }
      events.addEventListener('reset', e => { if (e.lastEventId) lastSeq = Number(e.lastEventId) || lastSeq; schedule() })
    }
    async function refresh() {
      if (stopped) return
      refreshAgain = true
      const result = refreshResult ??= new Promise(resolve => { finishRefresh = resolve })
      if (refreshPromise) return result
      refreshPromise = (async () => {
        try { do {
          // Callers need their snapshot, even when background progress keeps refreshing.
          const finish = finishRefresh
          refreshResult = finishRefresh = null
          refreshAgain = false
          try {
            const data = await api('GET', '/bootstrap')
            if (stopped) return
            if (data.enabled === false) { state.enabled = false; notify(); continue }
            state.enabled = true
            if (state.ownerId !== data.ownerId) {
              Object.assign(state, { ownerId: data.ownerId, messages: {}, attachments: {}, scrollPositions: {}, drafts: {}, pending: {}, uploads: {}, selected: null })
              try { Object.assign(state, JSON.parse(localStorage.getItem(storageKey()) || '{}')); for (const record of Object.values(state.pending)) record.sending = false } catch { /* invalid local cache */ }
            }
            state.demo = Boolean(data.demo); state.agents = data.agents; state.conversations = data.conversations
            if (!state.conversations.some(c => c.id === state.selected)) state.selected = state.conversations.find(c => c.isDefault)?.id || state.conversations[0]?.id
            mount?.()
            if (!initialized) {
              state.models = (await api('GET', '/models')).items
              if (stopped) return
              initialized = true
              lastSeq = Number(data.highWatermark) || 0
              state.online = true
              connectEvents()
            }
            state.error = ''; await loadConversation(state.selected); changed()
          } catch (error) {
            // 只有网络层失败才算断线；业务错误（带 code）不影响在线状态
            if (!error.code) state.online = false
            state.error = error.message; notify()
          }
          finally { finish() }
        } while (refreshAgain && !stopped) }
        finally { refreshPromise = null; if (stopped) { finishRefresh?.(); refreshResult = finishRefresh = null } }
      })()
      return result
    }
    function select(id) { state.selected = id; changed(); loadConversation(id).catch(error => { state.error = error.message; notify() }) }
    const draftOf = id => state.drafts[id] ??= { text: '', attachmentIds: [], mentions: [] }
    function draft(id, patch) { Object.assign(draftOf(id), patch); changed() }
    async function send(id, extra = {}, retry = false) {
      const conversation = state.conversations.find(c => c.id === id)
      if (!conversation || conversation.deletedAt || state.agents.find(a => a.agentId === conversation.directAgentId)?.deletedAt) return
      if (state.uploads[id] || (state.pending[id] && (!retry || state.pending[id].sending))) return
      const d = draftOf(id)
      const record = retry ? state.pending[id] : { questionDraft: extra.questionId ? structuredClone(d.questionDrafts?.[extra.questionId]) : undefined, fromDraft: extra.questionId === undefined, body: { clientMessageId: uid(), text: d.text, attachmentIds: [...d.attachmentIds], mentionAgentIds: [...d.mentions], contextSelectionId: d.contextSelectionId, ...extra } }
      if (!record?.body.text?.trim()) return
      state.pending[id] = { ...record, sending: true, error: '' }; changed()
      let accepted
      try {
        accepted = await api('POST', `/conversations/${id}/messages`, record.body)
        delete state.pending[id]
        const current = draftOf(id)
        const patch = { attachmentIds: current.attachmentIds.filter(aid => !record.body.attachmentIds.includes(aid)) }
        if (record.fromDraft ?? record.body.questionId === undefined) {
          if (current.text === record.body.text) patch.text = ''
          patch.mentions = current.mentions.filter(aid => !record.body.mentionAgentIds.includes(aid))
          if (current.contextSelectionId === record.body.contextSelectionId) patch.contextSelectionId = null
        }
        if (record.body.questionId && JSON.stringify(current.questionDrafts?.[record.body.questionId]) === JSON.stringify(record.questionDraft)) {
          patch.questionDrafts = { ...current.questionDrafts }; delete patch.questionDrafts[record.body.questionId]
        }
        draft(id, patch)
        await refresh()
        const run = await api('GET', `/runs/${accepted.runId}`)
        if (run.run.conversationId !== id) select(run.run.conversationId)
      } catch (error) {
        if (!accepted && error.details?.notAccepted === true) { delete state.pending[id]; state.error = error.message }
        else state.pending[id] = { ...record, sending: false, error: error.message }
        changed()
      }
    }
    function useStore() {
      const [, render] = useState(0)
      useEffect(() => { const fn = () => render(v => v + 1); listeners.add(fn); refresh(); return () => listeners.delete(fn) }, [])
      return state
    }
    const CSS = ".wbb-ui{box-sizing:border-box;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;color:var(--ink);display:flex;min-width:0;min-height:0;height:100%;width:100%;background:#fff}.wbb-ui button:disabled{opacity:.5;cursor:default}.wbb-ui .item{width:100%}.wbb-ui .app-head,.wbb-ui .list-head,.wbb-ui .chat-head,.wbb-ui .composer,.wbb-ui .tasks,.wbb-ui .artifact{flex-shrink:0}.wbb-ui .bubble{white-space:pre-wrap;overflow-wrap:anywhere}\n.wbb-ui{--blue:#2f6df6;--deep:#2058d4;--soft:#eef4ff;--ink:#1f2d45;--muted:#7d8da4;--line:#e5edf7;--shadow:0 20px 60px #234b8f33,0 4px 14px #234b8f1a;--w:760px;--h:620px}.wbb-ui *{box-sizing:border-box}.wbb-ui button,.wbb-ui input,.wbb-ui textarea,.wbb-ui select{font:inherit}.wbb-ui button{border:0;cursor:pointer}.wbb-ui button:focus-visible,.wbb-ui input:focus-visible,.wbb-ui textarea:focus-visible{outline:3px solid #b9d0ff;outline-offset:2px}.wbb-ui.launcher{position:fixed;right:22px;bottom:22px;z-index:20;width:58px;height:58px;display:grid;place-items:center;border-radius:19px;color:#fff;background:linear-gradient(145deg,#4d86ff,#2a62e5);box-shadow:0 13px 28px #2f6df655;transition:.2s}.wbb-ui.launcher:hover{transform:translateY(-3px) scale(1.03)}.wbb-ui.launcher.hidden{opacity:0;pointer-events:none;transform:scale(.8)}.wbb-ui .face{width:41px;height:41px;display:block}.wbb-ui.panel{position:fixed;z-index:21;left:calc(100vw - var(--w) - 22px);top:calc(100vh - var(--h) - 22px);width:var(--w);height:var(--h);min-width:300px;min-height:400px;display:flex;overflow:hidden;border:1px solid #cfdcf0;border-radius:20px;background:#fff;box-shadow:var(--shadow);transition:opacity .2s,transform .2s}.wbb-ui.panel.closed{opacity:0;pointer-events:none;transform:translateY(15px) scale(.97)}.wbb-ui .rail{width:48px;flex:0 0 48px;display:flex;flex-direction:column;align-items:center;padding:12px 7px;background:#f0f3f7;border-right:1px solid #e3e9f2}.wbb-ui .rail-face{width:31px;height:31px;margin-bottom:24px;display:grid;place-items:center;border-radius:10px;background:#dbe8ff}.wbb-ui .rail-btn{width:33px;height:33px;margin:3px 0;display:grid;place-items:center;border-radius:10px;color:#8290a4;background:transparent;font-size:17px}.wbb-ui .rail-btn.active{color:var(--blue);background:#dceaff}.wbb-ui .rail-spacer{flex:1}.wbb-ui .window{min-width:0;flex:1;display:flex;flex-direction:column}.wbb-ui .app-head{height:51px;display:flex;align-items:center;gap:10px;padding:0 13px;border-bottom:1px solid var(--line);user-select:none}.wbb-ui .drag{display:flex;align-items:center;gap:9px;min-width:0;flex:1;cursor:grab}.wbb-ui .drag:active{cursor:grabbing}.wbb-ui .app-title{font-size:13px;font-weight:750}.wbb-ui .app-sub{margin-top:2px;color:var(--muted);font-size:10px}.wbb-ui .head-actions{display:flex;gap:3px}.wbb-ui .head-btn,.wbb-ui .chat-icon{width:29px;height:29px;display:grid;place-items:center;border-radius:8px;color:#77869b;background:transparent;font-size:16px}.wbb-ui .head-btn svg{display:block}.wbb-ui .head-btn:hover,.wbb-ui .chat-icon:hover{color:var(--blue);background:var(--soft)}.wbb-ui .head-btn.close:hover{color:#d95268;background:#fff0f2}.wbb-ui .workspace{min-height:0;flex:1;display:flex}.wbb-ui .list-pane{width:244px;flex:0 0 244px;display:flex;flex-direction:column;background:#f7f8fa;border-right:1px solid var(--line)}.wbb-ui .list-head{height:55px;display:flex;align-items:center;gap:8px;padding:0 11px;border-bottom:1px solid #e9edf3}.wbb-ui .search{min-width:0;flex:1;height:32px;padding:0 10px;border:0;border-radius:8px;background:#edf0f4;font-size:11px}.wbb-ui .search::placeholder{color:#a4adbb}.wbb-ui .plus{width:30px;height:30px;display:grid;place-items:center;border-radius:9px;color:#68778b;background:#e8edf3;font-size:21px}.wbb-ui .plus:hover{color:var(--blue);background:#deebff}.wbb-ui .list{min-height:0;overflow:auto;padding:5px 0}.wbb-ui .section{padding:10px 13px 5px;color:#a5afbd;font-size:9px;font-weight:750;letter-spacing:.04em}.wbb-ui .item{position:relative;display:flex;align-items:center;gap:9px;min-height:59px;padding:8px 11px;border-bottom:1px solid #e9edf2;background:transparent;text-align:left}.wbb-ui .item:hover{background:#eef4ff}.wbb-ui .item.selected{background:#dce9ff}.wbb-ui .item.selected:before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--blue)}.wbb-ui .avatar{width:36px;height:36px;flex:0 0 36px;display:grid;place-items:center;border-radius:10px;color:#fff;font-weight:750;font-size:12px;position:relative}.wbb-ui .total{background:linear-gradient(145deg,#4a82ff,#2f66e8)}.wbb-ui .meeting{background:linear-gradient(145deg,#668df3,#4167d9)}.wbb-ui .policy{background:linear-gradient(145deg,#a566f1,#7646cf)}.wbb-ui .kb{background:linear-gradient(145deg,#b065ef,#8447d3)}.wbb-ui .ppt{background:linear-gradient(145deg,#27a9dc,#2875cb)}.wbb-ui .group{background:linear-gradient(145deg,#67a3fa,#4d72eb)}.wbb-ui .group:after{content:\"\";position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border:2px solid #f7f8fa;border-radius:50%;background:#18b77e}.wbb-ui .copy{min-width:0;flex:1}.wbb-ui .line{display:flex;align-items:center;gap:5px}.wbb-ui .line strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650}.wbb-ui .time{margin-left:auto;color:#a3acba;font-size:9px}.wbb-ui .preview{overflow:hidden;margin-top:5px;color:#9aa5b4;white-space:nowrap;text-overflow:ellipsis;font-size:10px}.wbb-ui .item.selected .preview{color:#6480af}.wbb-ui .unread{width:7px;height:7px;margin-left:auto;border-radius:50%;background:#f0646d}.wbb-ui .badge{display:inline-flex;padding:2px 5px;border-radius:5px;color:#4975c5;background:#e5efff;font-size:8px;font-weight:700}.wbb-ui .chat{min-width:0;flex:1;display:flex;flex-direction:column;background:#fff}.wbb-ui .chat-head{height:61px;display:flex;align-items:center;justify-content:space-between;padding:0 15px;border-bottom:1px solid var(--line)}.wbb-ui .chat-title{display:flex;align-items:center;gap:7px;font-size:15px;font-weight:700}.wbb-ui .online{width:7px;height:7px;border-radius:50%;background:#18b77e;box-shadow:0 0 0 3px #18b77e1c}.wbb-ui .meta{margin-top:5px;color:var(--muted);font-size:10px}.wbb-ui .stack{display:flex;align-items:center;margin-right:8px}.wbb-ui .tiny{width:23px;height:23px;margin-left:-5px;border:2px solid #fff;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:8px;font-weight:700}.wbb-ui .tiny:first-child{margin-left:0}.wbb-ui .t1{background:#3c75ee}.wbb-ui .t2{background:#587be1}.wbb-ui .t3{background:#9458e1}.wbb-ui .t4{background:#2887d3}.wbb-ui .chat-actions{display:flex;align-items:center;gap:3px}.wbb-ui .messages{min-height:0;flex:1;overflow:auto;padding:18px 17px 8px;background:linear-gradient(#fff,#fbfdff);scrollbar-width:thin;scrollbar-color:#cbdafa transparent}.wbb-ui .day{display:flex;align-items:center;gap:9px;margin:0 0 17px;color:#b0bac8;font-size:9px}.wbb-ui .day:before,.wbb-ui .day:after{content:\"\";height:1px;flex:1;background:#edf1f6}.wbb-ui .msg{display:flex;gap:8px;margin-bottom:15px}.wbb-ui .msg.me{justify-content:flex-end}.wbb-ui .wrap{max-width:86%;display:flex;flex-direction:column;align-items:flex-start}.wbb-ui .msg.me .wrap{align-items:flex-end;max-width:72%}.wbb-ui .name{margin:0 0 4px 1px;color:#8695aa;font-size:10px}.wbb-ui .name b{color:#657790}.wbb-ui .bubble{padding:9px 11px;border-radius:5px 13px 13px 13px;color:#40516b;background:#f1f4f8;font-size:11px;line-height:1.65}.wbb-ui .msg.me .bubble{border-radius:13px 5px 13px 13px;color:#fff;background:linear-gradient(135deg,#4b82fa,#2c65e7);box-shadow:0 4px 10px #2f6df628}.wbb-ui .msg-avatar{width:27px;height:27px;flex:0 0 27px;display:grid;place-items:center;border-radius:8px;color:#fff;font-size:9px;font-weight:750}.wbb-ui .msg-avatar.user{background:#1bb781}.wbb-ui .msg-avatar.total{background:#3e74ee}.wbb-ui .msg-avatar.meeting{background:#5879d8}.wbb-ui .msg-avatar.policy{background:#8b55d9}.wbb-ui .msg-avatar.kb{background:#9156dc}.wbb-ui .msg-avatar.ppt{background:#2c82d1}.wbb-ui .mention{color:var(--blue);font-weight:750}.wbb-ui .note{margin-top:7px;padding:7px 9px;border:1px solid #d8e6ff;border-radius:9px;color:#6d82a1;background:#f7faff;font-size:9px;line-height:1.55}.wbb-ui .note b{color:var(--blue)}.wbb-ui .msg.me .mention{color:#e4edff}.wbb-ui .tasks{display:none;gap:7px;padding:8px 14px;border-top:1px solid var(--line);background:#fbfdff}.wbb-ui .tasks.show{display:flex}.wbb-ui .task{min-width:0;flex:1;padding:7px 8px;border:1px solid #e3ebf7;border-radius:9px;background:#fff;cursor:pointer;text-align:left}.wbb-ui .task:hover{border-color:#bdd2ff}.wbb-ui .task-top{display:flex;align-items:center;gap:5px;font-size:9px;font-weight:700}.wbb-ui .task-icon{width:19px;height:19px;display:grid;place-items:center;border-radius:6px;color:#fff;background:var(--blue);font-size:9px}.wbb-ui .task.kb .task-icon{background:#8b5cf6}.wbb-ui .task.ppt .task-icon{background:#269a82}.wbb-ui .task p{overflow:hidden;margin:4px 0 0;color:var(--muted);white-space:nowrap;text-overflow:ellipsis;font-size:8px}.wbb-ui .bar{height:3px;margin-top:6px;overflow:hidden;border-radius:3px;background:#e9eff8}.wbb-ui .bar span{display:block;height:100%;border-radius:3px;background:var(--blue)}.wbb-ui .artifact{display:none;align-items:center;gap:8px;margin:0 14px 8px;padding:8px;border:1px solid #cfe0ff;border-radius:10px;background:#f6f9ff}.wbb-ui .artifact.show{display:flex}.wbb-ui .thumb{width:35px;height:25px;display:grid;place-items:center;border-radius:5px;color:#fff;background:linear-gradient(145deg,#4a82fa,#2a60df);font-size:8px;font-weight:800}.wbb-ui .artifact-copy{min-width:0;flex:1}.wbb-ui .artifact-copy b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.wbb-ui .artifact-copy span{color:var(--muted);font-size:8px}.wbb-ui .open{padding:5px 7px;border-radius:6px;color:var(--blue);background:#e5efff;font-size:9px}.wbb-ui .composer{position:relative;padding:9px 13px 11px;border-top:1px solid var(--line);background:#fff}.wbb-ui .composer textarea{width:100%;height:49px;resize:none;padding:9px 10px;border:1px solid #dce5f2;border-radius:10px;color:var(--ink);background:#fbfdff;font-size:11px;line-height:1.5}.wbb-ui .composer textarea::placeholder{color:#a8b3c2}.wbb-ui .tools{display:flex;align-items:center;gap:3px;margin-top:6px}.wbb-ui .tool{padding:5px 6px;border-radius:7px;color:#8090a7;background:transparent;font-size:9px}.wbb-ui .tool:hover{color:var(--blue);background:var(--soft)}.wbb-ui .composer .perm{max-width:88px;color:#5b7397}.wbb-ui .model{max-width:115px;padding:5px 17px 5px 6px;border:0;border-radius:7px;color:#71829c;background:#f2f5f9;font-size:9px}.wbb-ui .send{width:29px;height:26px;display:grid;place-items:center;margin-left:auto;border-radius:8px;color:#fff;background:var(--blue);font-size:14px}.wbb-ui .send:hover{background:var(--deep)}.wbb-ui .file{display:none}.wbb-ui .menu{position:fixed;z-index:40;display:none;width:137px;padding:5px;border:1px solid #dfe8f6;border-radius:10px;background:#fff;box-shadow:var(--shadow)}.wbb-ui .menu.show{display:block}.wbb-ui .menu button{width:100%;padding:7px 8px;border-radius:7px;color:#60738e;background:transparent;text-align:left;font-size:10px}.wbb-ui .menu button:hover{color:var(--blue);background:var(--soft)}.wbb-ui .toast{position:fixed;z-index:45;left:50%;bottom:20px;transform:translate(-50%,14px);opacity:0;pointer-events:none;padding:9px 13px;border:1px solid #d8e4f7;border-radius:9px;color:#58708f;background:#fff;box-shadow:0 7px 20px #3269b522;font-size:10px;transition:.18s}.wbb-ui .toast.show{opacity:1;transform:translate(-50%,0)}\n@media(max-width:760px){.wbb-ui.panel{left:10px!important;right:10px;top:auto!important;bottom:10px;width:auto;height:min(88vh,620px);min-width:0}.wbb-ui .rail{display:none}.wbb-ui .list-pane{width:31%;flex-basis:31%}.wbb-ui .item{padding-left:8px;padding-right:7px}.wbb-ui .line strong{font-size:10px}.wbb-ui .preview{font-size:8px}.wbb-ui .avatar{width:31px;height:31px;flex-basis:31px;font-size:10px}.wbb-ui .chat-head{padding-left:11px;padding-right:10px}.wbb-ui .messages{padding-left:11px;padding-right:11px}.wbb-ui.launcher{right:15px;bottom:15px}}@media(max-width:470px){.wbb-ui .list-pane{width:39%;flex-basis:39%}.wbb-ui .time,.wbb-ui .preview{display:none}.wbb-ui .item{min-height:52px}.wbb-ui .section{padding-left:8px}.wbb-ui .chat-title{font-size:13px}.wbb-ui .stack{display:none}.wbb-ui .tool:nth-child(2){display:none}.wbb-ui .model{max-width:98px}}\n\n.wbb-ui.launcher{height:58px;width:58px}.wbb-ui.panel .wbb-ui{border-radius:0}.wbb-ui .menu{z-index:160}.wbb-ui .wbb-pills{max-height:60px;overflow:auto}.wbb-ui .wbb-pills button{max-width:100%;overflow-wrap:anywhere;font-size:9px;color:#60738e;background:#eef4ff;border-radius:6px;padding:3px 5px}.wbb-ui .wbb-error{font-size:10px}.wbb-ui .task .bar span{transition:width .2s}.wbb-ui .task.meeting .bar span{background:#22b886}.wbb-ui .task.kb .bar span{background:#8b5cf6}.wbb-ui .empty{font-size:11px;color:#7d8da4}.wbb-ui .upload-tool{display:block!important}.wbb-ui .tools{flex-wrap:nowrap}.wbb-ui .tools .tool{white-space:nowrap;flex-shrink:0}.wbb-ui select.model{min-width:0;flex-shrink:1;appearance:auto;background-image:none}.wbb-ui .send{flex-shrink:0}.wbb-ui .chat-title{overflow-wrap:anywhere}.wbb-ui .chat-head>div:first-child{min-width:0}.wbb-ui .app-sub.offline{color:#ad6f29}.wbb-ui .artifact{flex-shrink:0}.wbb-ui .tasks{max-height:160px;overflow:auto}.wbb-ui.panel{z-index:80;max-width:calc(100vw - 20px);max-height:calc(100dvh - 20px);min-height:min(400px,calc(100dvh - 20px))}.wbb-ui{font-size:16px;line-height:normal}.wbb-ui .menu{max-height:240px;overflow:auto}.wbb-ui .notification{position:absolute;right:0;top:0;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:#f0646d;color:#fff;font-size:9px;line-height:14px}.wbb-ui .details-body{max-height:65vh;overflow:auto}@media(max-height:450px){.wbb-ui.panel .tasks,.wbb-ui.panel .artifact{display:none}}\n\n.wbb{box-sizing:border-box;min-width:0;color:#1f2d45;font:12px Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif}.wbb *{box-sizing:border-box}.wbb button,.wbb input,.wbb textarea,.wbb select{font:inherit}.wbb button{padding:6px 9px;border:1px solid #d8e4f7;border-radius:7px;color:#60738e;background:#f7faff;cursor:pointer}.wbb button:disabled{opacity:.5}.wbb .primary{color:#fff;background:#2f6df6;border-color:#2f6df6}.wbb input,.wbb textarea,.wbb select{padding:7px;border:1px solid #dce5f2;border-radius:8px;background:#fbfdff;color:#40516b;max-width:100%}.wbb-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}.wbb-head strong{flex:1}.wbb-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0}.wbb-quiet{font-size:10px;color:#7d8da4}.wbb-error{color:#bd4055;padding:6px;white-space:pre-wrap;overflow-wrap:anywhere}.wbb-run,.wbb-art{border:1px solid #d8e6ff;border-radius:9px;padding:8px;margin:7px 0;background:#f7faff}.wbb-art a{color:#2f6df6}.wbb-pills{display:flex;gap:4px;flex-wrap:wrap}.wbb button:focus-visible,.wbb input:focus-visible,.wbb textarea:focus-visible{outline:3px solid #b9d0ff;outline-offset:2px}\n.wbb-dialog-shade{position:fixed;inset:0;background:#0006;z-index:150;display:grid;place-items:center;padding:12px}.wbb-dialog{width:min(560px,100%);max-height:calc(100dvh - 24px);overflow:auto;border:1px solid #8792a655;border-radius:20px;padding:16px;background:#fff;color:#1f2d45;font-size:12px}.wbb-dialog label{display:block;margin:9px 0}.wbb-dialog input:not([type=checkbox]),.wbb-dialog textarea,.wbb-dialog select{width:100%}.wbb-dialog textarea{min-height:100px}.wbb-dialog img{display:block;width:100%;height:auto;margin:8px 0}.wbb-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.wbb-ui .bubble.md{white-space:normal}.wbb-ui .bubble.md>:first-child{margin-top:0}.wbb-ui .bubble.md>:last-child{margin-bottom:0}.wbb-ui .md p,.wbb-ui .md li{white-space:pre-wrap;margin:0 0 7px}.wbb-ui .md li{margin:2px 0}.wbb-ui .md h4,.wbb-ui .md h5,.wbb-ui .md h6{margin:11px 0 6px;font-size:14px;line-height:1.45;font-weight:700;color:var(--ink)}.wbb-ui .md h4{font-size:15px}.wbb-ui .md h5{font-size:14px}.wbb-ui .md h6{font-size:13px}.wbb-ui .md ul,.wbb-ui .md ol{margin:0 0 7px;padding-left:20px}.wbb-ui .md ul{list-style:disc}.wbb-ui .md ol{list-style:decimal}.wbb-ui .md blockquote{margin:0 0 7px;padding:1px 0 1px 10px;border-left:3px solid var(--line);color:var(--muted)}.wbb-ui .md code{padding:1px 5px;border-radius:5px;background:#f1f5fb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.wbb-ui .md pre{margin:0 0 7px;padding:9px 11px;border-radius:10px;background:#f6f8fc;border:1px solid var(--line);overflow:auto}.wbb-ui .md pre code{padding:0;background:none;white-space:pre}.wbb-ui .md hr{margin:10px 0;border:0;border-top:1px solid var(--line)}.wbb-ui .md a{color:var(--blue);text-decoration:underline;word-break:break-all}.wbb-ui .md table{margin:0 0 7px;border-collapse:collapse;font-size:12.5px;display:block;overflow-x:auto;max-width:100%}.wbb-ui .md th,.wbb-ui .md td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}.wbb-ui .md th{background:#f6f9ff;font-weight:600;white-space:nowrap}.wbb-ui .md strong{font-weight:700}"
    const botPaths = [["path", {"d": "M24 5.5v4.2", "stroke": "#2f6df6", "strokeWidth": "2.8", "strokeLinecap": "round"}], ["circle", {"cx": "24", "cy": "4.4", "r": "2.2", "fill": "#ffbd55"}], ["rect", {"x": "7", "y": "11", "width": "34", "height": "28", "rx": "10", "fill": "#fff", "stroke": "#2f6df6", "strokeWidth": "2.5"}], ["rect", {"x": "11", "y": "16", "width": "26", "height": "18", "rx": "7", "fill": "#eaf2ff"}], ["circle", {"cx": "19", "cy": "24", "r": "2.7", "fill": "#2f6df6"}], ["circle", {"cx": "29", "cy": "24", "r": "2.7", "fill": "#2f6df6"}], ["path", {"d": "M18 29c2.2 2.2 9.8 2.2 12 0", "fill": "none", "stroke": "#ff8193", "strokeWidth": "2", "strokeLinecap": "round"}], ["path", {"d": "M7 21H3.8M44.2 21H41", "stroke": "#2f6df6", "strokeWidth": "2.5", "strokeLinecap": "round"}], ["circle", {"cx": "3.4", "cy": "21", "r": "1.4", "fill": "#ffbd55"}], ["circle", {"cx": "44.6", "cy": "21", "r": "1.4", "fill": "#ffbd55"}], ["path", {"d": "M15 39v3M33 39v3", "stroke": "#2f6df6", "strokeWidth": "2.5", "strokeLinecap": "round"}]]
    const BotFace = () => h('svg', { className: 'face', viewBox: '0 0 48 48', 'aria-hidden': true }, botPaths.map(([tag, attrs], key) => h(tag, { ...attrs, key })))
    function Modal({ title, close, children }) {
      const ref = useRef()
      useEffect(() => { const prior = document.activeElement; ref.current?.querySelector('input,textarea,button,select')?.focus(); return () => { if (prior?.isConnected) prior.focus() } }, [])
      function keys(e) {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab') {
          const controls = [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,select,a[href]')]
          const first = controls[0], last = controls.at(-1)
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }
      return h('div', { className: 'wbb-dialog-shade', onClick: e => { if (e.target === e.currentTarget) close() } }, h('section', { className: 'wbb wbb-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title, ref, onKeyDown: keys }, h('div', { className: 'wbb-head' }, h('strong', {}, title), h('button', { onClick: close, 'aria-label': '关闭对话框' }, '关闭')), children))
    }
    const input = (label, value, change, type = 'text') => h('label', {}, label, h('input', { type, value, onChange: e => change(e.target.value) }))
    function RoleForm({ agent, close }) {
      const [title, setTitle] = useState(agent?.title || ''), [instructions, setInstructions] = useState(agent?.instructions || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      const request = useRef(uid())
      async function save(e) {
        e.preventDefault(); if (busy) return; setBusy(true); setError('')
        try {
          const body = { title, instructions, clientRequestId: request.current, ...(agent ? { expectedRevision: agent.revision } : {}) }
          const result = await api(agent ? 'PATCH' : 'POST', agent ? `/agents/${agent.agentId}` : '/agents', body)
          await refresh(); if (!agent) select(result.conversation.id); close()
          if (result.capabilityError) { state.error = result.capabilityError.message; notify() }
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: agent ? '编辑角色职责' : '创建自定义角色并私聊', close }, h('form', { onSubmit: save }, input('自定义名称（1–40 字符）', title, setTitle), h('label', {}, '长期职责（必填）', h('textarea', { value: instructions, required: true, maxLength: 32000, onChange: e => setInstructions(e.target.value) })), h('p', { className: 'wbb-quiet' }, '所有角色共享通用能力。修改职责后，新任务用新版本；已开始任务保留原快照。'), error && h('p', { className: 'wbb-error', role: 'alert' }, error), h('button', { className: 'primary', type: 'submit', disabled: busy || !title.trim() || !instructions.trim() }, busy ? '保存中…' : '保存')))
    }
    function ConversationForm({ kind, conversation, close, custom }) {
      useStore()
      const [title, setTitle] = useState(conversation?.title || ''), [chosen, setChosen] = useState(conversation?.members.filter(m => m.type === 'agent' && m.memberId !== 'chief').map(m => m.memberId) || []), [agentId, setAgentId] = useState('chief'), [independent, setIndependent] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState('')
      const request = useRef(uid())
      const available = state.agents.filter(a => !a.deletedAt && (a.lifecycle !== 'archived' || chosen.includes(a.agentId)) && a.title.includes(query))
      async function save(e) {
        e.preventDefault(); setBusy(true)
        try {
          const body = { kind, title, agentId, ...(kind === 'group' ? { agentIds: chosen } : {}), independent, clientRequestId: request.current, ...(conversation ? { expectedRevision: conversation.revision } : {}) }
          const result = await api(conversation ? 'PATCH' : 'POST', conversation ? `/conversations/${conversation.id}` : '/conversations', body)
          await refresh(); select(result.id); close()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: conversation ? '会话名称与成员' : kind === 'group' ? '新建协作群' : '新建私聊', close }, h('form', { onSubmit: save }, input('会话名称', title, setTitle), input('搜索已有角色', query, setQuery), kind === 'direct' && !conversation ? h('div', {}, h('select', { value: agentId, onChange: e => setAgentId(e.target.value), 'aria-label': '已有角色' }, available.map(a => h('option', { key: a.agentId, value: a.agentId, disabled: a.kind !== 'custom' && a.health !== 'ready' }, a.title + (a.health !== 'ready' ? ' · 当前不可用' : '')))), h('label', {}, h('input', { type: 'checkbox', checked: independent, onChange: e => setIndependent(e.target.checked) }), '建立独立上下文私聊'), h('button', { type: 'button', onClick: custom }, '创建自定义角色')) : kind === 'group' ? h('div', {}, h('p', {}, '总 Agent 固定协调；至少一名业务成员，可自由组合。'), available.filter(a => a.agentId !== 'chief').map(a => h('label', { key: a.agentId }, h('input', { type: 'checkbox', checked: chosen.includes(a.agentId), disabled: !chosen.includes(a.agentId) && a.kind !== 'custom' && a.health !== 'ready', onChange: e => setChosen(e.target.checked ? [...chosen, a.agentId] : chosen.filter(id => id !== a.agentId)) }), a.title + (a.lifecycle === 'archived' ? ' · 已归档' : a.health !== 'ready' ? ' · 当前不可用' : '')))) : null, error && h('p', { className: 'wbb-error', role: 'alert' }, error), h('button', { type: 'submit', className: 'primary', disabled: busy || (kind === 'group' && !chosen.length) }, busy ? '保存中…' : '保存并进入')))
    }
    function RoleManager({ close, edit }) {
      useStore(); const [error, setError] = useState(''), [busy, setBusy] = useState(false)
      const requests = useRef({})
      async function action(a, action) {
        if (busy || action === 'delete' && !confirmDeletion(a.title)) return
        setBusy(true)
        const key = `${a.agentId}:${action}:${a.revision}`
        const body = requests.current[key] ??= { action, expectedRevision: a.revision, clientRequestId: uid() }
        try { await api('POST', `/agents/${a.agentId}/actions`, body); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: '自定义角色管理', close }, state.agents.filter(a => a.kind === 'custom' && !a.deletedAt).map(a => h('div', { key: a.agentId, className: 'wbb-art' }, h('strong', {}, `${a.title} · 职责 v${a.instructionsVersion}`), h('p', {}, a.instructions), h('p', { className: 'wbb-quiet' }, a.lifecycle === 'archived' ? '已归档：保留历史与文件，已开始任务继续。' : '可接收新任务'), h('div', { className: 'wbb-row' }, h('button', { disabled: busy, onClick: () => edit(a) }, '编辑'), h('button', { disabled: busy, onClick: () => action(a, a.lifecycle === 'archived' ? 'restore' : 'archive') }, a.lifecycle === 'archived' ? '恢复' : '归档'), h('button', { disabled: busy, onClick: () => action(a, 'delete') }, '删除角色')))), error && h('p', { className: 'wbb-error' }, error))
    }
    const confirmDeletion = title => window.confirm(`删除“${title}”？已开始的任务继续完成，未开始的队列暂停；需要补充信息时等待恢复。历史和文件保留，可从回收站恢复；恢复后须手动确认继续。`)
    function Activity({ details, conversationId }) {
      const rows = []
      const labels = { accepted: '请求已接受，等待处理…', generating: '正在全力思考中…', replying: '正在回复…', unknown: '连接中断，正在核实任务状态…' }
      for (const { run, steps } of details) {
        if (run.cancelPending) { rows.push({ key: run.id, agentId: run.targetAgentIds?.[run.nextTarget || 0] || 'chief', text: '正在停止…' }); continue }
        if (!['running', 'ready', 'created', 'waiting_user'].includes(run.state)) continue
        if (run.state === 'waiting_user') { rows.push({ key: run.id, agentId: 'chief', text: '等待你补充信息' }); continue }
        const active = Object.entries(run.activity || {}).filter(([, activity]) => activity.stepId ? steps.some(step => step.id === activity.stepId && ['running', 'waiting_external'].includes(step.state)) : activity.sessionId === run.activeSessionId)
        for (const [agentId, activity] of active) rows.push({ key: `${run.id}:${agentId}`, agentId, text: labels[activity.phase] || labels.accepted })
        for (const step of steps.filter(step => ['running', 'waiting_external'].includes(step.state) && step.adapterId !== 'agent')) {
          const agentId = step.adapterId === 'business' ? 'chief' : step.adapterId
          if (!rows.some(row => row.key === `${run.id}:${agentId}`)) rows.push({ key: `${run.id}:${agentId}`, agentId, text: OP_LABELS[step.operation] || '正在处理业务操作…' })
        }
        if (!active.length && !steps.some(step => ['running', 'waiting_external'].includes(step.state))) rows.push({ key: run.id, agentId: run.targetAgentIds?.[run.nextTarget || 0] || 'chief', text: labels.accepted })
      }
      return h('div', { className: 'wbb-activity', role: 'status', 'aria-live': 'polite', 'aria-atomic': false }, state.pending[conversationId]?.sending && h('p', {}, '正在发送…'), rows.map(row => {
        const agent = state.agents.find(a => a.agentId === row.agentId)
        return h('div', { key: row.key, className: 'msg', 'data-agent-activity': row.agentId }, h('div', { className: `msg-avatar ${['chief', 'meeting', 'policy', 'kb', 'ppt'].includes(row.agentId) ? row.agentId === 'chief' ? 'total' : row.agentId : 'total'}`, 'aria-hidden': true }, agent?.title?.slice(0, 1) || 'A'), h('div', { className: 'wrap' }, h('div', { className: 'name' }, agent?.title || row.agentId, agent?.deletedAt ? ' · 角色已删除' : ''), h('div', { className: 'bubble' }, state.online ? row.text : labels.unknown)))
      }))
    }
    function RecycleBin({ close }) {
      useStore()
      const [items, setItems] = useState([]), [query, setQuery] = useState(''), [selected, setSelected] = useState(null), [details, setDetails] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      const requests = useRef({})
      useEffect(() => {
        let live = true
        Promise.all([(async () => {
          const items = []; let cursor = null
          do {
            const page = await api('GET', `/conversations?deleted=only&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
            items.push(...page.items); cursor = page.nextCursor
          } while (cursor && live)
          return { items }
        })(), api('GET', '/agents?deleted=only')]).then(([conversations, agents]) => {
          if (live) setItems([...conversations.items.map(row => ({ ...row, entity: 'conversations' })), ...agents.items.map(row => ({ ...row, id: row.agentId, entity: 'agents' }))])
        }).catch(e => { if (live) setError(e.message) })
        return () => { live = false }
      }, [state.conversations, state.agents])
      useEffect(() => {
        let live = true; setDetails(null)
        if (selected) (async () => {
          const runs = await api('GET', `/runs${selected.entity === 'conversations' ? `?conversationId=${encodeURIComponent(selected.id)}` : ''}`)
          const relevant = runs.items.filter(run => selected.entity === 'conversations' || run.participantAgentIds?.includes(selected.id))
          const tasks = await Promise.all(relevant.map(run => api('GET', `/runs/${run.id}`)))
          const messages = selected.entity === 'conversations' ? await api('GET', `/conversations/${selected.id}/messages`) : { items: [] }
          if (live) setDetails({ tasks, messages: messages.items, nextBeforeSeq: messages.nextBeforeSeq })
        })().catch(e => { if (live) setError(e.message) })
        return () => { live = false }
      }, [selected, state.conversations, state.agents])
      async function earlier() {
        if (busy || !details?.nextBeforeSeq) return
        setBusy(true); setError('')
        try {
          const page = await api('GET', `/conversations/${selected.id}/messages?beforeSeq=${details.nextBeforeSeq}`)
          setDetails(previous => previous === details ? { ...previous, messages: [...page.items, ...previous.messages], nextBeforeSeq: page.nextBeforeSeq } : previous)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      async function act(row, action, run) {
        if (busy) return
        setBusy(true); setError('')
        const key = `${run?.id || row.id}:${action}:${run?.revision || row.revision}`
        const body = requests.current[key] ??= { action, expectedRevision: run?.revision || row.revision, clientRequestId: uid() }
        try {
          await api('POST', run ? `/runs/${run.id}/actions` : `/${row.entity}/${row.id}/actions`, body)
          if (!run) { setSelected(null); setDetails(null) }
          await refresh()
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: '回收站', close }, h('p', {}, '历史和文件保留，无自动到期或永久清除。会话与角色分别恢复，待启动任务须手动确认继续。'), input('查找已删除对象', query, setQuery), ['私聊', '群聊', '角色'].map(group => h('section', { key: group }, h('h3', {}, group), items.filter(row => row.title.includes(query) && (row.entity === 'agents' ? group === '角色' : group === (row.kind === 'group' ? '群聊' : '私聊'))).map(row => h('div', { key: row.id, className: 'wbb-art' }, h('strong', {}, row.title), h('p', {}, `删除于 ${new Date(row.deletedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`), h('button', { 'aria-label': `查看${row.title}`, onClick: () => setSelected(row) }, '只读详情'), h('button', { disabled: busy, 'aria-label': `恢复${row.title}`, onClick: () => act(row, 'restore') }, '恢复'))))), selected && h('section', { 'aria-label': '回收站只读详情' }, h('h3', {}, selected.title), selected.instructions && h('p', {}, selected.instructions), details ? h('div', {}, details.nextBeforeSeq && h('button', { disabled: busy, onClick: earlier }, '更早消息'), !details.messages.length && h('p', {}, '暂无历史消息'), details.messages.map(message => h('p', { key: message.messageId }, message.text)), details.tasks.map(detail => h('div', { key: detail.run.id, className: 'wbb-art' }, h('strong', {}, detail.run.taskSpec.goal), h('p', {}, runStatus(detail.run)), !['delivered', 'cancelled', 'failed_terminal'].includes(detail.run.state) && h('button', { disabled: busy, onClick: () => act(selected, 'cancel', detail.run) }, '取消原任务'), detail.artifacts.filter(a => a.status === 'ready').map(artifact => h('a', { key: artifact.id, href: `${BASE}/artifacts/${artifact.id}/content?version=${encodeURIComponent(artifact.version)}`, download: true }, `${artifact.title} · ${artifact.version}`))))) : h('p', {}, '读取中…')), error && h('p', { role: 'alert', className: 'wbb-error' }, error))
    }
    async function setModel(conversation, agentId, model) {
      await api('PUT', `/conversations/${conversation.id}/model`, { agentId, model, expectedRevision: conversation.models?.[agentId]?.revision || 0 })
      await refresh()
    }
    async function setModels(conversation, model) {
      for (const member of (conversation.members || []).filter(m => m.type === 'agent')) {
        await api('PUT', `/conversations/${conversation.id}/model`, { agentId: member.memberId, model, expectedRevision: conversation.models?.[member.memberId]?.revision || 0 })
      }
      await refresh()
    }
    async function setPermission(conversation, permission) {
      await api('PUT', `/conversations/${conversation.id}/permission`, { permission, expectedRevision: conversation.permissionRevision || 0 })
      await refresh()
    }
    function MemberModels({ conversationId, close }) {
      useStore()
      const conversation = state.conversations.find(c => c.id === conversationId)
      const [error, setError] = useState(''), [busy, setBusy] = useState(false)
      return h(Modal, { title: '本会话成员与模型', close }, h('p', { className: 'wbb-quiet' }, '仅影响本会话该成员下一轮讨论。会议、知识库和 PPT 插件生成沿用各自模型规则。'), conversation.members.filter(m => m.type === 'agent').map(m => {
        const agent = state.agents.find(a => a.agentId === m.memberId)
        return h('div', { key: m.memberId, className: 'wbb-art' }, h('strong', {}, agent?.title || m.memberId), h('p', {}, `${agent?.lifecycle === 'archived' ? '已归档' : agent?.health === 'ready' ? '可用' : '当前不可用'} · 职责 v${agent?.instructionsVersion || 1}`), h('label', {}, `${agent?.title || m.memberId} · 下轮讨论模型`, h('select', { disabled: busy, value: conversation.models?.[m.memberId]?.model || '', onChange: async e => { setBusy(true); setError(''); try { await setModel(conversation, m.memberId, e.target.value) } catch (e) { setError(e.message) } finally { setBusy(false) } } }, h('option', { value: '' }, '宿主默认模型'), state.models.map(model => h('option', { key: model.ref, value: model.ref }, model.name || model.id)))))
      }), error && h('p', { className: 'wbb-error', role: 'alert' }, error))
    }
    function TaskForm({ conversationId, close }) {
      const request = useRef({ id: uid() })
      const [kind, setKind] = useState('meeting'), [goal, setGoal] = useState(draftOf(conversationId).text), [pages, setPages] = useState(8), [project, setProject] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      async function submit(e) {
        e.preventDefault(); if (busy || state.uploads[conversationId]) return; setBusy(true)
        let accepted = false
        try {
          const body = request.current.body ??= { conversationId, clientRequestId: request.current.id, attachmentIds: [...draftOf(conversationId).attachmentIds], taskSpec: { kind, deliverable: 'ppt', goal, pageCount: Number(pages), ...(project.trim() ? { projectScope: { folders: [project.trim()] } } : {}) } }
          await api('POST', '/runs', body); accepted = true
          const current = draftOf(conversationId)
          draft(conversationId, { ...(current.text === body.taskSpec.goal ? { text: '' } : {}), attachmentIds: current.attachmentIds.filter(id => !body.attachmentIds.includes(id)) })
          await refresh(); close()
        } catch (e) { if (!accepted && e.code === 'INVALID_MESSAGE') delete request.current.body; setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: '创建专业 PPT 任务', close }, h('form', { onSubmit: submit }, h('label', {}, '业务链', h('select', { value: kind, onChange: e => setKind(e.target.value) }, h('option', { value: 'meeting' }, '会议纪要 → PPT'), h('option', { value: 'policy' }, '政策 Word → 指定项目知识库 → PPT'))), h('label', {}, '任务目标', h('textarea', { value: goal, required: true, onChange: e => setGoal(e.target.value) })), input('页数（2–32）', pages, setPages, 'number'), kind === 'policy' && input('指定项目知识库目录（空白则等待用户选择）', project, setProject), h('p', { className: 'wbb-quiet' }, '使用当前会话已选附件。政策公开性、来源、角色、模式及效力信息会由原任务提问确认。'), error && h('p', { className: 'wbb-error' }, error), h('button', { disabled: busy || state.uploads[conversationId] || !goal.trim(), className: 'primary' }, busy ? '创建中…' : request.current.body ? '按原任务重试' : '开始协作')))
    }
    function Question({ question, conversationId, run, inspect }) {
      const saved = draftOf(conversationId).questionDrafts?.[question.id] || {}
      function saveQuestion(patch) { const d = draftOf(conversationId); draft(conversationId, { questionDrafts: { ...d.questionDrafts, [question.id]: { ...d.questionDrafts?.[question.id], ...patch } } }) }
      const [answer, updateAnswer] = useState(saved.answer || ''), [source, setSource] = useState('knowledge_only'), [role, setRole] = useState('policy_research'), [mode, setMode] = useState('policy_search'), [publicConfirmed, setPublic] = useState(false), [effectStatus, setEffectStatus] = useState('unresolved'), [evidence, updateEvidence] = useState(saved.evidence || {})
      function setAnswer(value) { updateAnswer(value); saveQuestion({ answer: value }) }
      function setEvidence(value) { updateEvidence(value); saveQuestion({ evidence: value }) }
      const [scopeKind, updateScopeKind] = useState(saved.scopeKind === 'files' ? 'files' : 'folders')
      const [reviewSelection, setReviewSelection] = useState(saved.requirementReview || { key: '', items: {} })
      const update = run.pendingUserUpdates?.[0], changes = update?.requestedChanges
      const [intent, setIntent] = useState(''), [goal, setGoal] = useState(changes && Object.keys(changes).length ? update.body.text : run.taskSpec.goal), [pages, setPages] = useState(changes?.pageCount?.to ?? run.taskSpec.pageCount), [family, setFamily] = useState(changes?.family?.to ?? run.taskSpec.family ?? '')
      const d = draftOf(conversationId)
      function submit(value, text = answer) { return send(conversationId, { text, questionId: question.id, answerValue: value, attachmentIds: question.field === 'policyAttachment' ? [...d.attachmentIds] : [], mentionAgentIds: [], contextSelectionId: null }) }
      if ((run.participantAgentIds || []).some(id => state.agents.find(a => a.agentId === id)?.deletedAt)) return h('p', { className: 'wbb-quiet' }, `${question.text} · 等待从回收站恢复相关角色后回答`)
      if (question.state !== 'open') return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), h('p', { className: 'wbb-quiet' }, '此问题已过期，未发送的内容仍保留。保存后仅作为补充信息，不会恢复旧计划。'), h('textarea', { value: answer || JSON.stringify(evidence), onChange: e => setAnswer(e.target.value), 'aria-label': '过期问题补充' }), h('button', { disabled: Boolean(state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit(undefined, answer || JSON.stringify(evidence)) }, '保存为补充信息'))
      if (question.field === 'projectScope') {
        const paths = answer.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
        return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text),
          h('select', { value: scopeKind, 'aria-label': '知识库范围类型', onChange: e => { updateScopeKind(e.target.value); saveQuestion({ scopeKind: e.target.value }) } }, h('option', { value: 'folders' }, '指定目录'), h('option', { value: 'files' }, '指定文件')),
          h('textarea', { value: answer, 'aria-label': '知识库相对路径', placeholder: '每行一个知识库相对路径', onChange: e => setAnswer(e.target.value) }),
          h('button', { disabled: !paths.length || Boolean(state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit({ [scopeKind]: paths }, '确认仅检索' + (scopeKind === 'files' ? '文件：' : '目录：') + paths.join('、')) }, '确认检索范围'))
      }
      if (question.field === 'taskInterruption') return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), h('p', { className: 'wbb-quiet' }, '插话已保存到原任务，确认处理方式前不会交付旧计划。'), h('select', { value: intent, onChange: e => setIntent(e.target.value), 'aria-label': '插话处理方式' }, h('option', { value: '', disabled: true }, '请选择处理方式'), h('option', { value: 'supplement' }, '仅补充当前任务说明'), h('option', { value: 'replan' }, '更改当前任务计划'), h('option', { value: 'new_task' }, '另起独立任务')), intent === 'replan' && h('div', {}, input('更改后的完整目标', goal, setGoal), input('更改后页数（2–32）', pages, setPages, 'number'), input('更改后的模板 ID', family, setFamily)), h('button', { disabled: !intent || Boolean(state.pending[conversationId] || state.uploads[conversationId]) || intent === 'replan' && (!goal.trim() || !Number.isInteger(Number(pages)) || Number(pages) < 2 || Number(pages) > 32), onClick: () => submit({ intent, ...(intent === 'replan' ? { goal, pageCount: Number(pages), family } : {}) }, '确认插话处理：' + ({ supplement: '仅补充说明', replan: goal, new_task: '另起独立任务' })[intent]) }, '确认插话处理'))
      if (question.field === 'pptBaseVersion') return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), h('p', { className: 'wbb-quiet' }, `版本校验值：${question.choices[0].sha256}`), h('button', { disabled: (state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit(question.choices[0], `明确以 ${question.choices[0].version} 继续重新生成，保留旧版`) }, `确认以 ${question.choices[0].version} 继续重新生成`))
      if (question.field === 'sampleApproval') {
        const preview=run.samplePreview, review=preview?.snapshot?.draft_review, units=review?.requirements || []
        const key=JSON.stringify([preview?.version,preview?.sha256,review?.source_sha256]), selected=reviewSelection.key===key?reviewSelection.items:{}
        const pages=[...new Set((review?.evidenceCatalog || []).map(e=>e.page).filter(Number.isInteger))]
        function choose(id,patch) { const value={key,items:{...selected,[id]:{...(selected[id]||{}),...patch}}};setReviewSelection(value);saveQuestion({requirementReview:value}) }
        const complete=units.length>0 && !review?.error && units.every(u=>selected[u.id]?.status==='verified'||selected[u.id]?.status==='superseded'&&units.some(n=>n.id===selected[u.id].superseded_by&&n.user_order!=null&&n.user_order>(u.user_order??-1)))
        const verification={version:preview?.version,sha256:preview?.sha256,source_sha256:review?.source_sha256,checks:units.map(u=>({id:u.id,...selected[u.id],evidence_ids:[],whole_deck:true,pages}))}
        return h('div', { className:'wbb wbb-art' }, h('strong',{},question.text),
          h('p',{className:'wbb-quiet'},`当前草稿 ${preview?.version}。请预览全部页面；修改后需重新核实，查看草稿不代表确认定稿。`),
          h('button',{onClick:()=>inspect({kind:'sample',run})},'查看当前全部草稿'),
          h('p',{className:'wbb-quiet'},'模型审阅仅辅助。明确要求未落实或尚待核实，不能定稿。'),
          review?.error && h('p',{className:'wbb-error'},review.error),
          units.map((u,i)=>h('div',{key:u.id},h('p',{},`${i+1}. ${u.quote}`),
            h('select',{'aria-label':`要求${i+1}核实状态`,value:selected[u.id]?.status||'unverified',onChange:e=>choose(u.id,{status:e.target.value})},
              h('option',{value:'unverified'},'待核实'),h('option',{value:'verified'},'已对照来源及当前页面核实'),h('option',{value:'superseded'},'已有明确新要求替代')),
            selected[u.id]?.status==='superseded' && h('select',{'aria-label':`要求${i+1}的新指令`,value:selected[u.id]?.superseded_by||'',onChange:e=>choose(u.id,{superseded_by:e.target.value})},h('option',{value:''},'选择明确的新要求'),units.filter(n=>n.user_order!=null&&n.user_order>(u.user_order??-1)).map(n=>h('option',{key:n.id,value:n.id},n.quote))))),
          !units.length && h('p',{className:'wbb-error'},'原始要求尚未取得，当前不能定稿；可先查看或提出修改。'),
          h('textarea',{value:answer,onChange:e=>setAnswer(e.target.value),'aria-label':'草稿修改要求',placeholder:'写明需要修改的页面、对象和要求'}),
          h('div',{className:'wbb-row'},h('button',{disabled:!complete||Boolean(state.pending[conversationId]||state.uploads[conversationId]),onClick:()=>submit({action:'approve',version:preview?.version,sha256:preview?.sha256,requirement_review:verification},'已对照来源和当前草稿逐项核实，确认定稿')},'确认当前草稿并定稿'),
            h('button',{disabled:!answer.trim()||Boolean(state.pending[conversationId]||state.uploads[conversationId]),onClick:()=>submit({action:'revise',instruction:answer,version:preview?.version,sha256:preview?.sha256},answer)},'提交修改要求')))
      }
      if (question.field === 'effectConfirmed') return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), h('select', { value: effectStatus, onChange: e => setEffectStatus(e.target.value), 'aria-label': '政策效力状态' }, ['unresolved','confirmed','expired','conflicting'].map((v,i) => h('option', { key: v, value: v }, ['待确认','已明确核对当前版本、日期和效力','已过期','存在冲突'][i]))), h('textarea', { value: answer, onChange: e => setAnswer(e.target.value), placeholder: '填写核对的版本、生效日期或未解决疑问', 'aria-label': '效力核对说明' }), h('button', { disabled: !answer.trim() || (state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit({ status: effectStatus, note: answer }, answer) }, '提交效力状态'))
      if (question.field === 'policyEvidence') return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), ['title','docNo','organ','url','publishDate','effectiveDate','validity','accessDate'].map((key,i) => input(['文件标题','文号','发文机关','官方原文 URL','发布日期','生效日期','效力说明','访问日期'][i], evidence[key] || '', value => setEvidence({ ...evidence, [key]: value }))), h('p', { className: 'wbb-quiet' }, '只填写真实来源，缺失字段保持空白；原生工具仍保留待人工复核状态。'), h('button', { disabled: (state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit(evidence, '已补充真实政策来源字段') }, '提交证据字段'))
      return h('div', { className: 'wbb wbb-art' }, h('strong', {}, question.text), question.field === 'policyGate' ? h('div', {}, h('label', {}, h('input', { type: 'checkbox', checked: publicConfirmed, onChange: e => setPublic(e.target.checked) }), '明确确认材料属于公开材料'), h('select', { value: source, onChange: e => setSource(e.target.value), 'aria-label': '政策来源' }, h('option', { value: 'knowledge_only' }, '政策补充仅知识库'), h('option', { value: 'web_only' }, '政策补充仅官方网络')), h('select', { value: role, onChange: e => setRole(e.target.value), 'aria-label': '政策角色' }, ['policy_research','business_execution','leadership','legal_review'].map((v, i) => h('option', { key: v, value: v }, ['政策研究','业务执行','领导决策','法律审查'][i]))), h('select', { value: mode, onChange: e => setMode(e.target.value), 'aria-label': '政策模式' }, ['policy_search','version_comparison','citation_verification','legality_review'].map((v, i) => h('option', { key: v, value: v }, ['政策检索','版本对比','引文核验','合法性审查'][i]))), h('button', { disabled: !publicConfirmed || (state.pending[conversationId] || state.uploads[conversationId]), onClick: () => submit({ publicConfirmed, source, role, mode }, '已明确确认业务门禁信息') }, '提交确认')) : h('div', {}, question.field === 'minutesId' ? h('select', { value: answer, onChange: e => setAnswer(e.target.value), 'aria-label': '选定纪要版本' }, h('option', { value: '' }, '请选择'), question.choices.map(c => h('option', { key: c.value, value: c.value }, c.label))) : h('textarea', { value: answer, onChange: e => setAnswer(e.target.value), placeholder: question.field === 'policyAttachment' ? '上传 DOCX 后说明所选版本' : '回答此问题；答案会关联原任务', 'aria-label': '问题答案' }), h('button', { disabled: (state.pending[conversationId] || state.uploads[conversationId]) || (!answer.trim() && question.field !== 'sampleApproval'), onClick: () => submit(question.field === 'sampleApproval' ? 'approve' : question.field === 'minutesId' ? answer : undefined, question.field === 'sampleApproval' ? '确认定稿' : answer) }, question.field === 'sampleApproval' ? '确认当前样张并定稿' : '提交答案'), question.field === 'policyAttachment' && h('p', { className: 'wbb-quiet' }, `已选 ${d.attachmentIds.length} 个附件`)))
    }
    function Artifact({ artifact, inspect, modify }) {
      return h('div', { className: 'wbb-art' }, h('strong', {}, `${artifact.title} · ${artifact.version}`), h('div', { className: 'wbb-row' }, h('button', { onClick: () => inspect({ kind: 'preview', artifact }) }, '预览'), h('a', { href: `${BASE}/artifacts/${artifact.id}/content?version=${encodeURIComponent(artifact.version)}`, download: true }, '下载'), h('button', { onClick: () => inspect({ kind: 'sources', artifact }) }, '查看来源'), h('button', { onClick: () => modify(artifact) }, '继续修改'), artifact.kind === 'ppt' && h('button', { onClick: () => inspect({ kind: 'editor', artifact }) }, '原插件编辑')))
    }
    function RunCard({ detail, inspect, modify, replan }) {
      const { run, steps, questions, artifacts } = detail, [error, setError] = useState('')
      async function action(action) {
        try { await api('POST', `/runs/${run.id}/actions`, { action, expectedRevision: run.revision, clientRequestId: uid() }); await refresh() } catch (e) { setError(e.message) }
      }
      return h('section', { className: 'wbb-run' }, h('strong', {}, runStatus(run)), run.sourceConversationId && run.sourceConversationId !== run.conversationId && h('button', { onClick: () => select(run.conversationId) }, '进入关联协作群'), h('p', {}, run.taskSpec.goal), run.blockedReason && h('p', { className: 'wbb-error' }, `${run.blockedReason} ${run.error || ''}`), h('details', {}, h('summary', {}, `实际执行步骤 ${steps.filter(s => s.state === 'succeeded').length}/${steps.length}`), steps.map(s => h('p', { key: s.id }, `${OP_LABELS[s.operation] || '业务操作'} · ${STEP_LABELS[s.state] || '状态待核对'}${s.error ? ' · ' + (s.error.message || JSON.stringify(s.error)) : ''}${s.cancelError ? ' · 取消未确认：' + s.cancelError : ''}`)), h('p', {}, `累计用量：请求 ${run.usage?.requests || 0}，Token ${run.usage?.tokens || 0}`)), h('div', { className: 'wbb-row' }, !['delivered','cancelled','failed_terminal'].includes(run.state) && h('button', { onClick: () => action(run.state === 'paused' ? 'resume' : 'pause') }, run.state === 'paused' ? '继续' : '暂停'), ['failed_retryable','interrupted','blocked'].includes(run.state) && h('button', { onClick: () => action('retry') }, '重试'), (run.blockedReason === 'OUTCOME_UNKNOWN' || run.state === 'interrupted' || steps.some(s => ['outcome_unknown','waiting_external'].includes(s.state))) && h('button', { onClick: () => action('reconcile') }, '对账'), !['delivered','cancelled','failed_terminal'].includes(run.state) && h('button', { onClick: () => action('cancel') }, '取消')), !['delivered','cancelled','failed_terminal'].includes(run.state) && run.kind === 'business' && h('button', { onClick: () => replan(run) }, '更改目标、页数或模板'), run.samplePreview && h('button', { onClick: () => inspect({ kind: 'sample', run }) }, `查看草稿 ${run.samplePreview.version}`), questions.filter(q => q.state === 'open' || Object.values(draftOf(run.conversationId).questionDrafts?.[q.id] || {}).some(v => typeof v === 'string' ? v.trim() : Object.values(v || {}).some(Boolean))).map(q => h(Question, { key: q.id, question: q, conversationId: run.conversationId, run, inspect })), artifacts.filter(a => a.status === 'ready').map(a => h(Artifact, { key: a.id, artifact: a, inspect, modify })), error && h('p', { className: 'wbb-error' }, error))
    }
    function Inspection({ data, close }) {
      const [text, setText] = useState('读取预览中…'), [error, setError] = useState(''), [retry, setRetry] = useState(0), artifact = data.artifact
      const [sources, setSources] = useState(null), [editor, setEditor] = useState(null)
      useEffect(() => { let active = true; if (['sources', 'editor'].includes(data.kind)) api('GET', `/artifacts/${artifact.id}/${data.kind}`).then(result => { if (active) data.kind === 'sources' ? setSources(result) : setEditor(result) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [retry])
      useEffect(() => { let active = true; if (data.kind === 'preview' && artifact.kind !== 'ppt') fetch(`${BASE}/artifacts/${artifact.id}/content?representation=preview&version=${encodeURIComponent(artifact.version)}`).then(r => { if (!r.ok) throw new Error('此版本预览读取失败，请刷新或重试'); return r.text() }).then(value => { if (active) setText(value) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [retry])
      const count = data.kind === 'sample' ? data.run.samplePreview.pageCount || data.run.samplePreview.snapshot?.report?.slide_count || data.run.taskSpec.pageCount : artifact?.previewPageCount
      if (data.kind === 'editor') return h(Modal, { title: '打开原 PPT 编辑器', close }, error ? h('p', { className: 'wbb-error', role: 'alert' }, error) : editor ? h('div', {}, h('p', {}, `${editor.title} · ${editor.version}`), h('p', { className: 'wbb-quiet' }, `项目编号：${editor.projectId}`), h('p', {}, '现有 PPT 插件打开事件仅支持进入主面板。打开后请选择上述项目，编辑前核对版本；原成品仍可下载与预览。'), h('button', { className: 'primary', onClick: () => { window.dispatchEvent(new CustomEvent('cappacks:open-huiwen-ppt')); close() } }, '打开汇文 PPT 面板')) : h('p', {}, '核对项目当前版本中…'))
      if (data.kind === 'sources') return h(Modal, { title: '本版本来源与逐页依据', close }, error && h('p', { className: 'wbb-error', role: 'alert' }, error), sources ? h('div', {}, h('p', {}, `成品 ${artifact.version} · 内容指纹 ${sources.contentHash || '未提供'}`), (sources.sourceRefs || []).map((ref, i) => h('p', { key: i }, typeof ref === 'string' ? ref : `${({ message:'授权消息', attachment:'选定附件', minutes:'选定会议纪要', artifact:'父成品' })[ref.type] || '来源'}：${ref.id || ref.messageId || ''}${ref.version ? ' · 版本 ' + ref.version : ''}`)), sources.frozenMinutes && h('details', {}, h('summary', {}, '本次冻结的会议原文'), h('pre', {}, sources.frozenMinutes.content)), sources.frozenPolicy && h('details', {}, h('summary', {}, `本次冻结的政策原文 · ${sources.frozenPolicy.effectConfirmation?.note || '效力待核对'}`), h('pre', {}, sources.frozenPolicy.text)), sources.projectScope && h('p', {}, `指定项目范围：${[...(sources.projectScope.folders || []), ...(sources.projectScope.files || [])].join('、')}`), (sources.pageSources || []).map(page => h('section', { key: page.n, className: 'wbb-art' }, h('strong', {}, `第 ${page.n} 页依据`), h('pre', {}, JSON.stringify(page.evidence, null, 2)))), h('details', {}, h('summary', {}, '证据核对、父版本与完整来源记录'), h('pre', {}, JSON.stringify(sources, null, 2)))) : h('p', {}, '读取固定版本来源中…'))
      return h(Modal, { title: data.kind === 'sources' ? '本版本来源与逐页依据' : '版本预览', close }, error && h('p', { className: 'wbb-error', role: 'alert' }, error, h('button', { onClick: () => { setError(''); setRetry(retry + 1) } }, '重试预览')), data.kind === 'sources' ? h('pre', {}, JSON.stringify({ sourceRefs: artifact.sourceRefs, pageSources: artifact.pageSources, parentRefs: artifact.parentRefs, contentHash: artifact.contentHash }, null, 2)) : data.kind === 'sample' || artifact.kind === 'ppt' ? Array.from({ length: count || 0 }, (_, i) => h('figure', { key: `${i}:${retry}` }, h('figcaption', {}, `第 ${i + 1} 页`), h('img', { alt: `第 ${i + 1} 页预览`, loading: 'lazy', onError: () => setError(`第 ${i + 1} 页预览读取失败，请确认版本或重试`), src: data.kind === 'sample' ? `${BASE}/runs/${data.run.id}/samples/content?page=${i + 1}&version=${data.run.samplePreview.version}` : `${BASE}/artifacts/${artifact.id}/content?representation=preview&page=${i + 1}&version=${artifact.version}` }))) : h('pre', {}, text))
    }
    function Modify({ artifact, close }) {
      const request = useRef(uid())
      const [goal, setGoal] = useState(''), [mode, setMode] = useState('revise'), [pages, setPages] = useState(artifact.previewPageCount || 8), [busy, setBusy] = useState(false), [error, setError] = useState('')
      async function save(e) { e.preventDefault(); setBusy(true); try { await api('POST', `/artifacts/${artifact.id}/actions`, { action: 'modify', goal, mode, pageCount: Number(pages), expectedVersion: artifact.version, clientRequestId: request.current }); await refresh(); close() } catch (e) { setError(e.message) } finally { setBusy(false) } }
      return h(Modal, { title: `继续修改 ${artifact.version}（旧版保留）`, close }, h('form', { onSubmit: save }, h('textarea', { value: goal, required: true, onChange: e => setGoal(e.target.value), 'aria-label': '修改要求' }), artifact.kind === 'ppt' && h('label', {}, '修改方式', h('select', { value: mode, onChange: e => setMode(e.target.value) }, h('option', { value: 'revise' }, '保留页面，按指令修订文字'), h('option', { value: 'regenerate' }, '重新规划整体结构与页数'))), artifact.kind === 'ppt' && mode === 'regenerate' && input('新页数', pages, setPages, 'number'), h('button', { className: 'primary', disabled: busy || !goal.trim() }, '创建关联修改任务'), error && h('p', { className: 'wbb-error' }, error)))
    }
    function ReplanForm({ run, close }) {
      const request = useRef(uid())
      const [goal, setGoal] = useState(run.taskSpec.goal), [pages, setPages] = useState(run.taskSpec.pageCount), [family, setFamily] = useState(run.taskSpec.family || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      const [families, setFamilies] = useState([]), [templateError, setTemplateError] = useState('')
      const originalScope = run.taskSpec.projectScope || run.projectScope || {}, policy = run.taskSpec.kind === 'policy'
      const [folders, setFolders] = useState((originalScope.folders || []).join('\n')), [files, setFiles] = useState((originalScope.files || []).join('\n')), [scopeConfirmed, setScopeConfirmed] = useState(false)
      const nextScope = Object.fromEntries([['folders', folders], ['files', files]].map(([key, text]) => [key, [...new Set(text.split('\n').map(value => value.trim()).filter(Boolean))]]).filter(([, values]) => values.length))
      const scopeChanged = policy && ['folders', 'files'].some(key => JSON.stringify([...(originalScope[key] || [])].sort()) !== JSON.stringify([...(nextScope[key] || [])].sort()))
      const expanding = scopeChanged && ['folders', 'files'].some(key => (nextScope[key] || []).some(value => !(originalScope[key] || []).includes(value)))
      useEffect(() => { let active = true; api('GET', '/ppt/templates').then(result => { if (active) setFamilies([...new Set((result.layouts || []).map(layout => layout.family).filter(Boolean))]) }).catch(e => { if (active) setTemplateError(e.message) }); return () => { active = false } }, [])
      async function save(e) {
        e.preventDefault(); setBusy(true)
        try { await api('POST', `/runs/${run.id}/actions`, { action: 'replan', taskSpec: { goal, pageCount: Number(pages), ...(family ? { family } : {}), ...(scopeChanged ? { projectScope: nextScope } : {}) }, ...(expanding ? { scopeExpansionConfirmed: scopeConfirmed } : {}), expectedRevision: run.revision, expectedPlanRevision: run.planRevision, clientRequestId: request.current }); await refresh(); close() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: '更改当前任务计划', close }, h('form', { onSubmit: save }, h('label', {}, '新的目标或修改要求', h('textarea', { value: goal, required: true, onChange: e => setGoal(e.target.value) })), input('新页数（2–32）', pages, setPages, 'number'), h('label', {}, '模板（来自汇文 PPT）', h('select', { value: family, onChange: e => setFamily(e.target.value) }, h('option', { value: '' }, '沿用当前模板'), [...new Set([run.taskSpec.family, ...families].filter(Boolean))].map(id => h('option', { key: id, value: id }, id)))), templateError && h('p', { className: 'wbb-error' }, `模板目录暂不可用：${templateError}`), policy && h('fieldset', {}, h('legend', {}, '项目检索范围'), h('label', {}, '项目知识库目录（每行一个）', h('textarea', { value: folders, onChange: e => { setFolders(e.target.value); setScopeConfirmed(false) } })), h('label', {}, '精确文件（每行一个，可留空）', h('textarea', { value: files, onChange: e => { setFiles(e.target.value); setScopeConfirmed(false) } })), expanding && h('label', {}, h('input', { type: 'checkbox', checked: scopeConfirmed, onChange: e => setScopeConfirmed(e.target.checked) }), '明确确认本次扩大到上述新增目录或文件'), h('p', { className: 'wbb-quiet' }, '仅查询明确列出的范围；补证需重新检索。旧范围、原政策版本和旧成品保留可追溯，不会自动全库检索。')), h('p', { className: 'wbb-quiet' }, '正在执行的业务写操作先对账，旧计划结果不会作为新要求成品交付。'), h('button', { className: 'primary', disabled: busy || !goal.trim() || expanding && !scopeConfirmed || scopeChanged && !Object.keys(nextScope).length }, '提交新计划'), error && h('p', { className: 'wbb-error' }, error)))
    }
    function ContextForm({ conversationId, close }) {
      const [sourceId, setSourceId] = useState(state.conversations.find(c => c.id !== conversationId)?.id || ''), [messages, setMessages] = useState([]), [chosen, setChosen] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
      const request = useRef(uid())
      useEffect(() => { let active = true; setChosen([]); setMessages([]); if (sourceId) api('GET', `/conversations/${sourceId}/messages`).then(r => { if (active) setMessages(r.items) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [sourceId])
      async function save() {
        setBusy(true)
        try { const context = await api('POST', '/contexts', { sourceConversationId: sourceId, sourceMessageIds: chosen, clientRequestId: request.current }); draft(conversationId, { contextSelectionId: context.id }); close() } catch (e) { setError(e.message) } finally { setBusy(false) }
      }
      return h(Modal, { title: '明确选择外部上下文', close }, h('p', { className: 'wbb-quiet' }, '仅转入选定的 1–20 条消息快照，不读取其他会话的隐式记忆。'), h('select', { value: sourceId, onChange: e => { request.current = uid(); setSourceId(e.target.value) }, 'aria-label': '来源会话' }, state.conversations.filter(c => c.id !== conversationId).map(c => h('option', { key: c.id, value: c.id }, c.title))), messages.map(m => h('label', { key: m.messageId }, h('input', { type: 'checkbox', checked: chosen.includes(m.messageId), disabled: chosen.length >= 20 && !chosen.includes(m.messageId), onChange: e => { request.current = uid(); setChosen(e.target.checked ? [...chosen, m.messageId] : chosen.filter(id => id !== m.messageId)) } }), m.text)), h('button', { className: 'primary', disabled: busy || !chosen.length, onClick: save }, '使用选定消息'), error && h('p', { className: 'wbb-error' }, error))
    }
    function Workbench({ floating, maximize, close, restore, drag }) {
      useStore()
      const [search, setSearch] = useState(''), [dialog, setDialog] = useState(null), [menu, setMenu] = useState(null), [uploadError, setUploadError] = useState(''), [tasksVisible, setTasksVisible] = useState(true)
      const composing = useRef(false), scroll = useRef(), fileInput = useRef()
      const conv = state.conversations.find(c => c.id === state.selected), d = conv && draftOf(conv.id), rows = state.messages[conv?.id], currentRuns = state.runs[conv?.id] || [], uploading = Boolean(state.uploads[conv?.id])
      const agentName = id => { const a = state.agents.find(a => a.agentId === id); return (a?.title || id) + (a?.deletedAt ? ' · 角色已删除' : '') }
      useEffect(() => { if (scroll.current) { const saved = state.scrollPositions[conv?.id]; scroll.current.scrollTop = !saved || saved.atBottom ? scroll.current.scrollHeight : saved.top } }, [conv?.id, rows?.items.at(-1)?.messageId])
      async function upload(e) {
        const files = [...e.target.files]; e.target.value = ''; setUploadError('')
        const id = conv.id
        state.uploads[id] = (state.uploads[id] || 0) + 1; notify()
        try {
          for (const file of files) {
            if (file.size > 30 * 1024 * 1024) throw new Error('单个附件上限 30MB')
            const dataBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file) })
            const attachment = await api('POST', '/attachments', { conversationId: id, name: file.name, dataBase64, clientRequestId: uid() })
            if (attachment.state !== 'ready') throw new Error(attachment.error || '附件解析失败')
            state.attachments[attachment.id] = attachment
            draft(id, { attachmentIds: [...draftOf(id).attachmentIds, attachment.id] })
          }
        } catch (e) { setUploadError(e.message) } finally { state.uploads[id]--; notify() }
      }
      async function older() {
        try { const page = await api('GET', `/conversations/${conv.id}/messages?beforeSeq=${rows.nextBeforeSeq}`); state.messages[conv.id] = { ...rows, items: mergeMessages(conv.id, page.items), nextBeforeSeq: page.nextBeforeSeq, loadedOlder: true }; notify() } catch (e) { state.error = e.message; notify() }
      }
      function open(id) { select(id); setMenu(null) }
      const inspect = data => setDialog({ kind: 'inspection', data }), modify = artifact => setDialog({ kind: 'modify', artifact }), replan = run => setDialog({ kind: 'replan', run })
      const agentClass = id => id === 'chief' ? 'total' : ['meeting','policy','kb','ppt'].includes(id) ? id : 'total'
      const initials = id => id === 'ppt' ? 'P' : agentName(id).slice(0,1)
      const day = value => { const date = new Date(value); return `${date.toDateString() === new Date().toDateString() ? '今天' : date.toLocaleDateString('zh-CN')} ${time(value)}` }
      const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
      const lastMessage = id => state.messages[id]?.items.at(-1) || state.conversations.find(c => c.id === id)?.lastMessage
      const agent = state.agents.find(a => a.agentId === conv?.directAgentId)
      const readOnly = Boolean(conv?.deletedAt || agent?.deletedAt)
      const [deleting, setDeleting] = useState(false)
      const deletionRequest = useRef({})
      async function deleteConversation() {
        if (deleting || !confirmDeletion(conv.title)) return
        setDeleting(true)
        const body = deletionRequest.current[conv.id] ??= { action: 'delete', expectedRevision: conv.revision, clientRequestId: uid() }
        try { await api('POST', `/conversations/${conv.id}/actions`, body); await refresh() }
        catch (error) { state.error = error.message; notify() }
        finally { setDeleting(false) }
      }
      const descriptions = { chief: '随时帮你协调工作台能力', meeting: '会议纪要与行动项', policy: '证据链与政策依据', kb: 'RAG 检索与来源引用', ppt: '生成、渲染与继续编辑' }
      const stepLabels = STEP_LABELS
      const details = currentRuns.filter(detail => detail.run.kind === 'business')
      const artifacts = currentRuns.flatMap(detail => detail.artifacts).filter(a => a.status === 'ready')
      const latestArtifact = artifacts.at(-1)
      function toggleMenu(kind, event) {
        const rect = event.currentTarget.getBoundingClientRect(), height = kind === 'mention' ? Math.min(240, (conv.memberCount || 1) * 34) : kind === 'create' ? 76 : kind === 'navigation' ? 110 : 240
        setMenu(menu?.kind === kind ? null : { kind, trigger: event.currentTarget, left: Math.max(8, Math.min(rect.left - (kind === 'create' ? 98 : 0), innerWidth - 145)), top: kind === 'mention' ? Math.max(8, rect.top - height - 8) : Math.min(rect.bottom + 5, innerHeight - height - 8) })
      }
      useEffect(() => {
        const outside = e => { if (!e.target.closest('.menu,[data-wbb-menu]')) setMenu(null) }
        const key = e => { if (e.key === 'Escape') setMenu(null) }
        document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key)
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
      }, [])
      const menuButton = (text, action) => h('button', { key: text, onClick: () => {
        // Modal must capture the persistent trigger before this menu item unmounts.
        if (menu.trigger?.isConnected) menu.trigger.focus()
        setMenu(null); action()
      } }, text)
      const dialogContent = dialog && (
        dialog.kind === 'recycle' ? h(RecycleBin, { close: () => setDialog(null) }) :
        dialog.kind === 'role' ? h(RoleForm, { agent: dialog.agent, close: () => setDialog(null) }) :
        dialog.kind === 'roles' ? h(RoleManager, { close: () => setDialog(null), edit: agent => setDialog({ kind: 'role', agent }) }) :
        dialog.kind === 'models' ? h(MemberModels, { conversationId: conv.id, close: () => setDialog(null) }) :
        ['direct','group','conversation'].includes(dialog.kind) ? h(ConversationForm, { kind: dialog.conversation?.kind || dialog.kind, conversation: dialog.conversation, close: () => setDialog(null), custom: () => setDialog({ kind: 'role' }) }) :
        dialog.kind === 'task' ? h(TaskForm, { conversationId: conv.id, close: () => setDialog(null) }) :
        dialog.kind === 'inspection' ? h(Inspection, { data: dialog.data, close: () => setDialog(null) }) :
        dialog.kind === 'modify' ? h(Modify, { artifact: dialog.artifact, close: () => setDialog(null) }) :
        dialog.kind === 'replan' ? h(ReplanForm, { run: dialog.run, close: () => setDialog(null) }) :
        dialog.kind === 'context' ? h(ContextForm, { conversationId: conv.id, close: () => setDialog(null) }) :
        dialog.kind === 'runs' ? h(Modal, { title: '任务与产物', close: () => setDialog(null) }, h('div', { className: 'details-body' }, currentRuns.length ? currentRuns.map(detail => h(RunCard, { key: detail.run.id, detail, inspect, modify, replan })) : h('p', {}, '本会话还没有任务'))) : null)
      const items = (isDefault, kind) => state.conversations.filter(c => Boolean(c.isDefault) === isDefault && (!kind || c.kind === kind) && (c.title + (lastMessage(c.id)?.text || '') + c.members.map(m => agentName(m.memberId)).join(' ')).includes(search)).sort((a,b) => isDefault ? ['chief','meeting','policy','kb','ppt'].indexOf(a.directAgentId) - ['chief','meeting','policy','kb','ppt'].indexOf(b.directAgentId) : b.updatedAt - a.updatedAt)
      const conversationItem = c => h('button', { key: c.id, className: `item ${c.id === state.selected ? 'selected' : ''}`, onClick: () => open(c.id), 'aria-current': c.id === state.selected ? 'page' : undefined },
        h('div', { className: `avatar ${c.kind === 'group' ? 'group' : agentClass(c.directAgentId)}` }, c.kind === 'group' ? '群' : initials(c.directAgentId)),
        h('div', { className: 'copy' }, h('div', { className: 'line' }, h('strong', {}, c.title), h('span', { className: 'time' }, time(lastMessage(c.id)?.createdAt))), h('div', { className: 'preview' }, c.kind === 'group' && h('span', { className: 'badge' }, `${c.memberCount} 位成员`), c.waitingUser ? ' 等待回答' : mdPlain(lastMessage(c.id)?.text || '') || '开始新会话')), c.unread > 0 && h('i', { className: 'unread', 'aria-label': `${c.unread} 条未读` }))
      const messageRow = m => {
        const user = m.sender?.type === 'user', id = m.sender?.id, name = user ? '你' : m.sender?.type === 'system' ? '系统' : agentName(id)
        const avatar = h('div', { className: `msg-avatar ${user ? 'user' : agentClass(id)}` }, user ? '我' : name.slice(0,1))
        const body = h('div', { className: 'wrap' }, h('div', { className: 'name' }, h('b', {}, name), h('span', {}, time(m.createdAt))), h('div', { className: user ? 'bubble' : 'bubble md' }, user ? m.text : mdBlocks(m.text), (m.attachmentIds || []).map(aid => h('div', { key: aid, className: 'note' }, `附件：${state.attachments[aid]?.name || aid} · ${state.attachments[aid]?.state === 'ready' ? '已解析' : '读取状态中'}`)), (m.artifactRefs || []).map(id => { const artifact = artifacts.find(a => a.id === id); return artifact && h('button', { key: id, className: 'open', onClick: () => inspect({ kind: 'preview', artifact }) }, '打开产物') })))
        return h('article', { key: m.messageId, className: `msg${user ? ' me' : ''}`, 'data-sender-type': m.sender?.type, 'data-sender-id': id }, user ? body : avatar, user ? avatar : body)
      }
      return h('div', { className: 'wbb-ui', 'data-workbench-view': floating ? 'floating' : 'main' },
        h('aside', { className: 'rail', 'aria-label': 'Bot 导航' }, h('div', { className: 'rail-face' }, h(BotFace)), h('button', { className: 'rail-btn active', title: '当前会话', onClick: () => select(state.selected) }, '●'), h('button', { className: 'rail-btn', title: '自定义角色', 'aria-label': '自定义角色', onClick: () => setDialog({ kind: 'roles' }) }, '♙'), h('button', { className: 'rail-btn', title: '任务与产物', 'aria-label': '任务与产物', onClick: () => setDialog({ kind: 'runs' }) }, '◇'), h('div', { className: 'rail-spacer' }), h('button', { className: 'rail-btn', title: '工作台与功能菜单', 'aria-label': '工作台与功能菜单', 'data-wbb-menu': true, onClick: e => toggleMenu('navigation', e) }, '☰')),
        h('div', { className: 'window' },
          h('header', { className: 'app-head' }, h('div', { className: 'drag', onPointerDown: floating ? drag : undefined }, h('div', {}, h('div', { className: 'app-title' }, 'DSH Bot'), h('div', { className: `app-sub${state.online ? '' : ' offline'}`, role: 'status' }, state.demo ? '示例模式 · 历史仅供演示' : state.online ? '你的工作台智能协作助手' : '连接恢复中 · 你的工作台智能协作助手'))), h('div', { className: 'head-actions' }, floating && h('button', { className: 'head-btn', onClick: maximize, title: '最大化', 'aria-label': '最大化悬浮窗' }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: 'M6.5 2.5H2.5v4M9.5 13.5h4v-4M2.5 6.5l4-4M13.5 9.5l-4 4' }))), h('button', { className: 'head-btn close', onClick: floating ? close : restore, title: floating ? '关闭' : '还原为悬浮窗', 'aria-label': floating ? '关闭悬浮窗' : '还原为悬浮窗' }, '×'))),
          state.error && h('div', { className: 'wbb-error', role: 'alert' }, state.error, h('button', { onClick: refresh }, '重新连接')),
          h('div', { className: 'workspace' },
            h('aside', { className: 'list-pane', 'aria-label': '会话列表' }, h('div', { className: 'list-head' }, h('input', { className: 'search', value: search, placeholder: '搜索会话', 'aria-label': '搜索会话', onChange: e => setSearch(e.target.value) }), h('button', { className: 'plus', title: '新建会话或群聊', 'aria-label': '新建会话或群聊', 'data-wbb-menu': true, onClick: e => toggleMenu('create', e) }, '＋')), h('div', { className: 'list' }, h('div', { className: 'section' }, '智能体会话'), items(true).map(conversationItem), items(false,'direct').length > 0 && h('div', { className: 'section' }, '其他私聊'), items(false,'direct').map(conversationItem), h('div', { className: 'section' }, '群聊'), items(false,'group').map(conversationItem))),
            conv ? h('section', { className: 'chat', 'aria-label': conv.title },
              h('header', { className: 'chat-head' }, h('div', {}, h('div', { className: 'chat-title' }, conv.title, conv.kind === 'direct' && agent?.health === 'ready' && h('i', { className: 'online' })), h('div', { className: 'meta' }, conv.kind === 'group' ? `${conv.memberCount} 位成员 · ${[...(conv.members || []).filter(m => m.type === 'agent').map(m => agentName(m.memberId)), ...((conv.members || []).some(m => m.type === 'user') ? ['你'] : [])].join('、')}` : `${agent?.health === 'ready' ? '可用' : '当前不可用'} · ${descriptions[conv.directAgentId] || agent?.instructions || '自定义角色'}`)), h('div', { className: 'chat-actions' }, conv.kind === 'group' && h('div', { className: 'stack' }, (conv.members || []).filter(m => m.type === 'agent').slice(0,4).map((m,i) => h('span', { key: m.memberId, className: `tiny t${i+1}`, title: agentName(m.memberId) }, initials(m.memberId)))), h('button', { className: 'chat-icon', title: '会话信息', 'aria-label': '会话信息', 'data-wbb-menu': true, onClick: e => toggleMenu('info', e) }, '···'))),
              h('div', { className: 'messages', ref: scroll, onScroll: e => { const el = e.currentTarget; state.scrollPositions[conv.id] = { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 20 } } }, rows?.nextBeforeSeq && h('button', { className: 'open', onClick: older }, '加载更早消息'), rows?.items.length ? h('div', { className: 'day' }, day(rows.items[0].createdAt)) : null, (rows?.items || []).map(messageRow), !conv.deletedAt && h(Activity, { details: currentRuns, conversationId: conv.id }), !rows?.items.length && h('p', { className: 'empty' }, '开始当前会话，消息与文件会保留在这里。'), currentRuns.flatMap(detail => detail.questions.filter(q => q.state === 'open' || Object.values(draftOf(detail.run.conversationId).questionDrafts?.[q.id] || {}).some(v => typeof v === 'string' ? v.trim() : Object.values(v || {}).some(Boolean))).map(q => h(Question, { key: q.id, question: q, conversationId: detail.run.conversationId, run: detail.run, inspect })))),
              tasksVisible && details.length > 0 && h('div', { className: 'tasks show' }, Object.entries(details.at(-1).steps.reduce((groups, step) => { (groups[step.operation === 'agent.analyze' ? step.input.agentId : step.adapterId] ??= []).push(step); return groups }, {})).filter(([id]) => !['chief','business'].includes(id)).map(([id,steps]) => h('button', { key: id, className: `task ${id}`, onClick: () => setDialog({ kind: 'runs' }) }, h('div', { className: 'task-top' }, h('span', { className: 'task-icon' }, id === 'meeting' ? '✦' : id === 'kb' ? '◆' : '▣'), agentName(id)), h('p', {}, `${steps.filter(s => s.state === 'succeeded').length} / ${steps.length} 步完成 · ${stepLabels[steps.find(s => s.state !== 'succeeded')?.state] || '已完成'}`), h('div', { className: 'bar' }, h('span', { style: { width: `${steps.filter(s => s.state === 'succeeded').length / steps.length * 100}%` } }))))),
              latestArtifact && h('div', { className: 'artifact show' }, h('div', { className: 'thumb' }, latestArtifact.kind === 'ppt' ? 'PPT' : latestArtifact.format.toUpperCase()), h('div', { className: 'artifact-copy' }, h('b', {}, `${latestArtifact.title} ${latestArtifact.version}`), h('span', {}, '可预览 · 可下载 · 可继续编辑')), h('button', { className: 'open', onClick: () => inspect({ kind: 'preview', artifact: latestArtifact }) }, '打开')),
              h('fieldset', { className: 'composer', disabled: readOnly, style: { border: 0, margin: 0, minWidth: 0 } }, readOnly && h('p', { role: 'status' }, '角色已删除，请先从回收站恢复。历史和文件可查看。'), h('div', { className: 'wbb-pills' }, d.attachmentIds.map(id => h('button', { key: id, onClick: () => draft(conv.id, { attachmentIds: d.attachmentIds.filter(x => x !== id) }) }, `${state.attachments[id]?.name || '附件'} · 已解析 ×`)), d.mentions.map(id => h('button', { key: id, onClick: () => draft(conv.id, { mentions: d.mentions.filter(x => x !== id) }) }, `@${agentName(id)} ×`)), d.contextSelectionId && h('button', { onClick: () => draft(conv.id, { contextSelectionId: null }) }, '已选外部上下文 ×')),
                h('textarea', { value: d.text, placeholder: '输入消息，或 @ 一个 Agent…', 'aria-label': '消息正文', onChange: e => draft(conv.id, { text: e.target.value }), onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false }, onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent?.isComposing && e.keyCode !== 229) { e.preventDefault(); send(conv.id, { contextSelectionId: d.contextSelectionId }) } } }),
                h('div', { className: 'tools' }, h('button', { className: 'tool', disabled: conv.kind !== 'group', 'data-wbb-menu': true, onClick: e => toggleMenu('mention', e) }, '＠ Agent'), h('button', { className: 'tool upload-tool', disabled: uploading, onClick: () => fileInput.current.click() }, uploading ? '解析中…' : '⌕ 上传'), h('input', { className: 'file', type: 'file', multiple: true, accept: '.txt,.md,.docx,.pdf', ref: fileInput, onChange: upload }), h('select', { className: 'model perm', value: conv.permission || 'danger-full-access', onChange: async e => { const permission = e.target.value; try { await setPermission(conv, permission) } catch (err) { state.error = err.message; notify() } }, title: '本会话权限 · 成员 Bot 同步生效', 'aria-label': '本会话权限' }, h('option', { value: 'read-only' }, '仅可查看'), h('option', { value: 'workspace-write' }, '工作区内修改'), h('option', { value: 'danger-full-access' }, '完全权限')), h('select', { className: 'model', value: conv.models?.[conv.directAgentId || 'chief']?.model || '', onChange: async e => { const model = e.target.value; try { if (conv.kind === 'group') await setModels(conv, model); else await setModel(conv, conv.directAgentId || 'chief', model) } catch (err) { state.error = err.message; notify() } }, title: conv.kind === 'group' ? '本会话模型 · 全部成员同步' : `${agentName(conv.directAgentId || 'chief')} · 下轮讨论生效`, 'aria-label': '本会话模型' }, h('option', { value: '' }, '宿主默认模型'), state.models.map(m => h('option', { key: m.ref, value: m.ref }, m.name || m.id))), h('button', { className: 'send', title: '发送', 'aria-label': '发送', disabled: !d.text.trim() || state.pending[conv.id] || uploading, onClick: () => send(conv.id, { contextSelectionId: d.contextSelectionId }) }, '↑')),
                uploadError && h('p', { className: 'wbb-error' }, uploadError), state.pending[conv.id]?.error && h('p', { className: 'wbb-error' }, state.pending[conv.id].error, h('button', { onClick: () => send(conv.id, {}, true) }, '按原消息重发')))) : h('p', { className: 'empty' }, '正在加载会话…'))),
        menu && h('div', { className: 'menu show', style: { left: menu.left, top: menu.top }, role: 'menu' }, menu.kind === 'create' ? [menuButton('＋ 新建一对一会话', () => setDialog({ kind: 'direct' })), menuButton('＋ 新建群聊', () => setDialog({ kind: 'group' }))] : menu.kind === 'mention' ? conv.members.filter(m => m.type === 'agent' && !state.agents.find(a => a.agentId === m.memberId)?.deletedAt).map(m => menuButton(agentName(m.memberId), () => { if (!d.mentions.includes(m.memberId)) draft(conv.id, { mentions: [...d.mentions,m.memberId] }) })) : menu.kind === 'navigation' ? [menuButton('回收站', () => setDialog({ kind: 'recycle' })), menuButton('打开主界面', openMain), menuButton('自定义角色', () => setDialog({ kind: 'roles' })), menuButton('创建专业 PPT 任务', () => setDialog({ kind: 'task' }))] : [menuButton('打开主界面', openMain), menuButton('会话名称与成员', () => setDialog({ kind: 'conversation', conversation: conv })), menuButton('成员与下轮模型', () => setDialog({ kind: 'models' })), menuButton('任务与产物', () => setDialog({ kind: 'runs' })), menuButton(tasksVisible ? '折叠任务摘要' : '展开任务摘要', () => setTasksVisible(!tasksVisible)), menuButton('选择外部上下文', () => setDialog({ kind: 'context' })), menuButton('创建专业 PPT 任务', () => setDialog({ kind: 'task' })), menuButton('自定义角色管理', () => setDialog({ kind: 'roles' })), menuButton('回收站', () => setDialog({ kind: 'recycle' })), !conv.isDefault && h('button', { key: 'delete', disabled: deleting, onClick: () => { setMenu(null); deleteConversation() } }, conv.kind === 'group' ? '解散群聊' : '删除私聊')]), dialogContent)
    }
    function MainPanel() {
      useEffect(() => { setSidebarCollapsed(true); return () => setSidebarCollapsed(false) }, [])
      return h(Workbench, { restore: restoreFloating })
    }
    function Overlay() {
      useStore()
      const [visible, setVisible] = useState(true)
      const [position, setPosition] = useState({ x: Math.max(10, innerWidth - 782), y: Math.max(10, innerHeight - 642) })
      const unread = state.conversations.reduce((n,c) => n + c.unread, 0), waiting = state.conversations.some(c => c.waitingUser)
      const notification = (unread || waiting) && h('span', { className: 'notification', 'aria-label': waiting ? '有任务待回答' : `${unread} 条未读` }, waiting ? '!' : Math.min(unread,99))
      const ref = useRef(), stopDrag = useRef()
      function clamp(point) { return { x: Math.min(Math.max(10, point.x), Math.max(10, innerWidth - (ref.current?.offsetWidth || 760) - 10)), y: Math.min(Math.max(10, point.y), Math.max(10, innerHeight - (ref.current?.offsetHeight || 620) - 10)) } }
      function open() { setVisible(true) }
      useEffect(() => { const resize = () => setPosition(p => clamp(p)); window.addEventListener('resize', resize); window.addEventListener('workbench-bot:open', open); return () => { window.removeEventListener('resize', resize); window.removeEventListener('workbench-bot:open', open); stopDrag.current?.() } }, [])
      function drag(e) {
        if (e.target.closest('button,input,select') || e.button !== 0 || innerWidth <= 760) return
        e.preventDefault(); const start = { x: e.clientX, y: e.clientY }, origin = position
        const move = event => setPosition(clamp({ x: origin.x + event.clientX - start.x, y: origin.y + event.clientY - start.y }))
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop) }
        stopDrag.current?.(); stopDrag.current = stop; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop); window.addEventListener('blur', stop)
      }
      return visible ? h('section', { className: 'wbb-ui panel', style: { left: position.x, top: position.y }, ref, 'aria-label': 'DSH Bot 微信式悬浮窗' }, h(Workbench, { floating: true, maximize: () => { setVisible(false); selectMainPanel('workbench-bot'); setSidebarCollapsed(true) }, close: () => setVisible(false), drag })) : h('button', { className: 'wbb-ui launcher', onClick: open, 'aria-label': '打开 DSH Bot' }, h(BotFace), notification)
    }
    const Icon = ({ size }) => h(primitives.IconAgentPresetOutlineRegular || primitives.IconPluginPinwheelOutlineRegular, { size: size || 16 })
    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        stopped = false
        let disposed = false
        layoutControl = (() => { try { return ctx.get?.('layout') || ctx.layout || null } catch { return null } })()
        openMain = () => selectMainPanel('workbench-bot')
        const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style)
        const disposers = []
        mount = () => {
          if (disposed || stopped || disposers.length) return
          disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'workbench-bot', label: 'Bot 协作', order: 20 }, Icon)), ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench-bot' }, MainPanel)), ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'workbench-bot-overlay' }, Overlay)))
          window.__workbenchBot = { open: () => window.dispatchEvent(new Event('workbench-bot:open')) }
        }
        refresh()
        const storage = e => { if (e.key === storageKey() && e.newValue) { try { const value = JSON.parse(e.newValue); state.drafts = { ...state.drafts, ...value.drafts }; loadConversation(state.selected); notify() } catch { /* malformed peer cache */ } } }
        window.addEventListener('storage', storage)
        const visibility = () => { if (document.visibilityState === 'visible') refresh() }; document.addEventListener('visibilitychange', visibility)
        return () => { disposed = true; stopped = true; clearTimeout(timer); clearTimeout(eventTimer); clearInterval(pollTimer); events?.close(); events = null; initialized = false; window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', visibility); delete window.__workbenchBot; style.remove(); for (const dispose of disposers) dispose?.(); listeners.clear(); layoutControl = null }
      },
    }
  },
})
