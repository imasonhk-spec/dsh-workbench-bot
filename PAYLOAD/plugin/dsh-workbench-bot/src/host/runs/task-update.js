// shortcut: bind explicit page/template/quoted-title edits; ambiguous wording needs user confirmation.
export function requestedTaskChanges(message, currentTask) {
  const changes = { currentTask: { pageCount: currentTask.pageCount, family: currentTask.family || '' } }
  // Title literals describe text, not authorization to change pages or templates.
  const authorization = message.replace(/(?:主标题|标题)\s*(?:改成|改为|用|使用|设为)\s*[“"「]([^”"」\n]+)[”"」]/g, text => ' '.repeat(text.length))
  for (const [field, pattern] of [
    ['pageCount', /(?:改成|改为|调整为|调整到|变成|改)\s*([\d一二三四五六七八九十]+)\s*页/g],
    ['family', /模板\s*(?:改成|改为|调整为|用|使用|换成)\s*[“"']?([a-zA-Z][\w-]*)/g],
    ['title', /(?:^|[，。；\n])\s*(?:第[一1]页|首页|封面)?\s*(?:主标题|标题)\s*(?:改成|改为|用|使用|设为)\s*[“"「]([^”"」\n]+)[”"」]/g],
  ]) {
    const source = field === 'title' ? message : authorization
    if (field !== 'title' && [...message.matchAll(pattern)].length && ![...source.matchAll(pattern)].length) changes.ambiguous = true
    for (const match of source.matchAll(pattern)) {
      const digits = match[1].split('十'), number = value => value.length === 1 ? '一二三四五六七八九'.indexOf(value) + 1 : 0
      const to = field !== 'pageCount' ? match[1] : /^\d+$/.test(match[1]) ? Number(match[1]) : digits.length === 2 ? (number(digits[0]) || 1) * 10 + number(digits[1]) : number(match[1])
      const prefix = field === 'title' ? '' : source.slice(0, match.index).split(/[，。；\n]/).at(-1)
      const suffix = source.slice(match.index + match[0].length)
      const ambiguous = /(?:不|无需|无须|别|勿|禁止)[^，。；\n]*$/.test(prefix) || /^\s*[”"']?\s*(?:不(?:需要|用|要|必|行|可以)|无需|无须|取消|算了)/.test(suffix) || changes[field] && changes[field].to !== to || changes[field]?.ambiguous
      if (ambiguous) changes.ambiguous = true
      changes[field] = { from: currentTask[field] ?? '', to, quote: match[0], ...(ambiguous ? { ambiguous: true } : {}) }
    }
  }
  for (const [field, subject] of [['pageCount', '页'], ['family', '模板'], ['title', '标题']]) {
    const body = field === 'title' ? message : authorization
    const preserved = body.split(/[，。；\n]/).some(clause => /保持|保留|不变|沿用|维持/.test(clause) && (field === 'pageCount' ? /页数|(?:保持|保留|维持)\s*[\d一二三四五六七八九十]+\s*页/.test(clause) : clause.includes(subject)))
    if (preserved || !changes[field] && body.includes(subject) && (field === 'pageCount' ? /改|调整|换|设为/ : /改|调整|换|设为|用/).test(body)) changes.ambiguous = true
  }
  // A page's scope can be in a preceding sentence; keep it out of the global title.
  if (changes.title) {
    const quote = changes.title.quote, start = message.indexOf(quote)
    const before = message.slice(0, start), surrounding = before + message.slice(start + quote.length)
    const scope = /^\s*[，。；]?\s*(?:第[一1]页|首页|封面)/.test(quote) ? before : surrounding
    if (/第\s*(?![一1]\s*(?:页|张))[\d一二三四五六七八九十百两]+\s*(?:页|张)/.test(scope) || /封面[^，。；\n]*不变|(?:保持|保留)[^，。；\n]*封面/.test(surrounding)) { changes.ambiguous = true; changes.title.ambiguous = true }
  }
  return changes
}

export function matchesTaskChanges(decision, changes = {}) {
  if (changes.ambiguous) return false
  if (decision?.intent === 'replan' && ['pageCount', 'family'].some(field => !changes[field] && decision[field] !== undefined && decision[field] !== changes.currentTask?.[field])) return false
  const fields = ['pageCount', 'family', 'title'].filter(key => changes[key])
  if (!fields.length) return true
  if (decision?.intent !== 'replan') return false
  return fields.every(key => key === 'title' ? typeof decision.goal === 'string' && decision.goal.includes(changes[key].to) : decision[key] === changes[key].to)
}
