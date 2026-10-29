// license-http.mjs —— 授权 HTTP 收口（随插件分发）
//
// 为什么不做成「再注册一个 prefix」：插件已经占用了 /api/<plugin> 这个前缀，
// 再注册一个 /api/<plugin>/license 是否生效取决于宿主的匹配顺序（先注册 vs 最长匹配），
// 不可靠。这里改成**在插件自己的 prefix handler 最前面插一行 guard**，
// 由我们先把授权路径处理掉，剩下的才落回业务路由 —— 与宿主路由实现完全解耦。
//
// 提供的端点（均在 /api/<plugin>/license 下）：
//   GET  state      授权状态（零票、不烧池；含机器码，供客户报给我们）
//   POST import     导入 O2 离线激活包（raw 二进制 .licpack / JSON {pack:<base64>} / JSON 原文）
//   POST activate   输入激活码（能联网的场景用）
//   GET  ui         自带的离线激活页面（现场用浏览器打开即可，无需前端集成）
import { createGate } from './license-gate.mjs';

const MAX_BODY = 64 * 1024 * 1024;   // 1 万票 gzip 包约 0.7MB，给足余量

function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body_too_large')); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  } catch {}
}

/**
 * 安装授权收口
 * @param {object} ctx            DSH 插件上下文
 * @param {object} o
 * @param {string} o.pluginId     插件 id（如 'huiwen-ppt'），必须与平台登记一致
 * @param {string} o.prefix       插件已有的 HTTP 前缀（如 '/api/huiwen-ppt'）
 * @param {number} [o.poolTarget] 在线领票池目标（离线包场景可忽略）
 * @param {function} [o.logger]
 */
export function installLicense(ctx, { pluginId, prefix, poolTarget = 500, logger = () => {}, standalone = false } = {}) {
  const base = prefix.replace(/\/+$/, '') + '/license';
  let gate;
  try {
    gate = createGate({ pluginId, dataDir: process.env.DSH_LICENSE_DATA_DIR || undefined, poolTarget, logger });
  } catch (e) {
    // 设计律 L-A：apply 绝不 throw。授权运行时初始化失败时**放行**并高声告警，
    // 宁可少一道门禁，也不能让插件加载失败拖垮整个 DSH 宿主。
    logger('[license] gate init failed, FAIL-OPEN:', e && e.message);
    try { console.error('[license] gate init failed, FAIL-OPEN:', e && e.message); } catch {}
    gate = {
      pluginId, hwid: null, server: null,
      allow: async () => ({ allowed: true, bypass: true }),
      state: async () => ({ ready: true, usable: true, plugin_id: pluginId, reason: 'gate_init_failed' }),
      importPack: async () => ({ ok: false, error: 'gate_init_failed', message: '授权运行时初始化失败：' + (e && e.message) }),
      activate: async () => ({ usable: true, reason: 'gate_init_failed' }),
      flush: () => {}, deny: () => {},
    };
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
    const p = url.pathname;
    if (p !== base && !p.startsWith(base + '/')) return false;   // 不是授权路径 → 交回业务路由
    const sub = p.slice(base.length).replace(/^\/+/, '');
    try {
      if (sub === 'state' || sub === '') {
        return json(res, 200, await gate.state()), true;
      }
      if (sub === 'import' && req.method === 'POST') {
        const ct = String(req.headers['content-type'] || '');
        const body = await readRaw(req);
        let payload = body;
        if (ct.includes('application/json')) {
          let o = {}; try { o = JSON.parse(body.toString('utf-8')); } catch { return json(res, 400, { ok: false, error: 'bad_json', message: '请求体不是合法 JSON' }), true; }
          payload = o.pack || o.data || o;
          if (typeof payload === 'string') payload = Buffer.from(payload, 'base64');
        }
        const r = await gate.importPack(payload);
        logger('license import', { ok: r.ok, error: r.error });
        return json(res, r.ok ? 200 : 400, r), true;
      }
      if (sub === 'activate' && req.method === 'POST') {
        const body = await readRaw(req, 64 * 1024);
        let code = '';
        try { const o = JSON.parse(body.toString('utf-8')); code = o.code || o.key || ''; } catch { code = body.toString('utf-8').trim(); }
        if (!code) return json(res, 400, { ok: false, error: 'code_required' }), true;
        const st = await gate.activate(code);
        return json(res, st.usable ? 200 : 200, { ok: st.usable, state: st }), true;
      }
      if (sub === 'ui') {
        const html = uiHtml(pluginId, base);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return true;
      }
      return json(res, 404, { ok: false, error: 'not_found' }), true;
    } catch (e) {
      logger('license route error', e && e.message);
      return json(res, 500, { ok: false, error: 'internal', message: String(e && e.message || e) }), true;
    }
  }

  // 同步判定 + 异步处理：只接管 /license/* 路径，不判断业务授权
  function intercept(req, res) {
    let p = '';
    try { p = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
    if (p !== base && !p.startsWith(base + '/')) return false;
    handle(req, res).catch((e) => json(res, 500, { ok: false, error: 'internal', message: String(e && e.message || e) }));
    return true;
  }

  // ---- 业务门禁（同步，插在 handler 第一行：`if (__lic.guard(req, res)) return;`）----
  //
  // ⚠️ 为什么必须是同步的，而不是 `await gate.allow()`：
  //   1) 已上机的 handler 形态各异（块式 / async 箭头 / 非 async 箭头返回 promise），
  //      往非 async 函数里插 `await` 会直接产生语法错误；
  //   2) allow() 每调一次消耗一张票 —— 前端一次页面加载几十个请求，100 张票撑不过一屏。
  // 所以这里用「2 秒轮询缓存 usable」的软门禁：有证有票就放行，不烧票；
  // 票池的消耗仍由业务侧的显式 allow()（工具型 execute）或在线 sync 核销负责。
  let usableNow = false;
  let warmed = false;
  let warmTimer = null;
  // ★ v1.2：静默模式下 402 彻底失效（只留 revoked 一条路），这里缓存一份供 guard 快速判
  let silentNow = true;
  async function refresh() {
    try {
      const st = await gate.state();
      usableNow = !!st.usable;
      silentNow = st.silent !== false;
    } catch {
      usableNow = true;   // gate.state 自身抛错 → fail-open（L-A：授权层不能拖垮宿主）
      silentNow = true;
    }
    warmed = true;
  }
  refresh();
  try {
    warmTimer = setInterval(refresh, 2000);
    if (warmTimer.unref) warmTimer.unref();
  } catch {}

  /**
   * 业务门禁：命中授权路径交给授权层；否则判授权，未授权回 402。
   * @returns {boolean} true = 请求已被处理（调用方立刻 return），false = 继续走业务
   */
  function guard(req, res) {
    if (intercept(req, res)) return true;
    /* ★ v1.2 SILENT：静默模式下业务接口一律放行。
       这是“装上即用”的最后一道保障 —— 即使 gate.state() 因为意外返回 usable=false，
       也不该把客户的业务请求挡成 402（那会表现为插件整个页面打不开）。 */
    if (silentNow) return false;
    if (!warmed || usableNow) return false;
    const st = { plugin_id: pluginId };
    json(res, 402, {
      ok: false,
      code: 'LICENSE_REQUIRED',
      message: '本插件需要有效授权。请打开 ' + base + '/ui 查看机器码并激活，或联系服务商导入离线激活包。',
      plugin_id: pluginId,
      license_url: base + '/ui',
      state: st,
    });
    return true;
  }

  function dispose() {
    try { if (warmTimer) clearInterval(warmTimer); } catch {}
  }

  // ---- 工具型插件（无 HTTP 业务前缀）：自己注册 /api/<id>/license ----
  // 工具型只有 ctx.tools.execute 一个入口，installer 没有现成的 handler 可挂 intercept，
  // 客户在现场就没有任何办法看机器码/导入离线包。这里补一个只服务授权路径的 prefix。
  let ownRoute = null;
  if (standalone) {
    try {
      const ws = ctx && (ctx.webServer || (ctx.get && ctx.get('webServer')));
      if (ws && typeof ws.register === 'function') {
        ownRoute = ws.register({
          kind: 'prefix',
          path: base,
          handler: (req, res) => {
            if (intercept(req, res)) return;
            json(res, 404, { ok: false, error: 'not_found' });
          },
        });
      } else {
        logger('[license] standalone 请求注册授权路由，但 ctx 上没有 webServer');
      }
    } catch (e) {
      logger('[license] standalone 注册失败（不影响 allow 门禁）', e && e.message);
    }
  }

  // 释放（插件卸载时调用；心跳定时器 unref 了，不释放也不会阻塞退出）
  return (globalThis.__DSH_LIC__ || (globalThis.__DSH_LIC__ = {}))[pluginId] = {
    gate, handle, intercept, guard, dispose, refresh, prefix: base,
    disposeRoute: () => {
      try {
        if (typeof ownRoute === 'function') ownRoute();
        else if (ownRoute && typeof ownRoute.dispose === 'function') ownRoute.dispose();
        else if (ownRoute && typeof ownRoute.unregister === 'function') ownRoute.unregister();
      } catch {}
    },
  };
}

// ---- 自带激活页（零依赖、内联；现场浏览器打开 /api/<plugin>/license/ui）----
function uiHtml(pluginId, base) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pluginId} · 授权与离线激活</title>
<style>
:root{--bg:#f6f8fb;--card:#fff;--line:#e3e8ef;--tx:#1f2937;--muted:#6b7280;--ok:#16a34a;--bad:#dc2626;--pri:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.kv{display:grid;grid-template-columns:112px 1fr;gap:6px 12px;font-size:14px}
.kv b{font-weight:600;color:var(--muted);font-size:13px}
code.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3f5f9;border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:13px;word-break:break-all}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.ok{background:#e8f7ee;color:var(--ok)} .badge.bad{background:#fdeceb;color:var(--bad)}
.badge.warn{background:#fff6e5;color:#b45309}
.drop{border:2px dashed #c7d2e0;border-radius:12px;padding:26px;text-align:center;color:var(--muted);cursor:pointer;transition:.15s;background:#fbfcfe}
.drop:hover,.drop.hot{border-color:var(--pri);background:#eef4ff;color:var(--pri)}
button{font:inherit;padding:9px 16px;border-radius:10px;border:1px solid transparent;background:var(--pri);color:#fff;cursor:pointer;font-weight:600}
button.ghost{background:#fff;border-color:var(--line);color:var(--tx);font-weight:500}
button:disabled{opacity:.5;cursor:not-allowed}
input[type=text]{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;width:300px}
pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:10px;font-size:12.5px;overflow:auto;max-height:220px;margin:12px 0 0}
.hint{font-size:12.5px;color:var(--muted);margin-top:10px}
</style></head>
<body><div class="wrap">
  <h1>授权管理 · ${pluginId}</h1>
  <div class="sub">离线（局域网隔离）场景：把本页「机器码」发给服务商 → 拿到 <code class="mono">.licpack</code> → 在下方导入，全程无需外网。</div>

  <div class="card">
    <h2>当前授权 <span id="badge" class="badge warn">读取中</span></h2>
    <div class="kv">
      <b>机器码</b><div><code class="mono" id="mc">-</code> <button class="ghost" onclick="copyMc()">复制</button></div>
      <b>授权范围</b><div id="scope">-</div>
      <b>授权编号</b><div id="lid">-</div>
      <b>到期时间</b><div id="exp">-</div>
      <b>本地票池</b><div id="pool">-</div>
      <b>授权来源</b><div id="via">-</div>
      <b>服务端</b><div><code class="mono" id="srv">-</code></div>
    </div>
    <div class="hint" id="reason"></div>
  </div>

  <div class="card">
    <h2>导入离线激活包</h2>
    <div class="drop" id="drop">把 <b>.licpack</b> 文件拖到这里，或点击选择文件<input type="file" id="file" accept=".licpack,application/octet-stream,application/gzip" hidden></div>
    <div class="hint">包与本机机器码绑定，换机/改机不可用；导入不消耗流量，不修改已用票数。</div>
    <pre id="log" hidden></pre>
  </div>

  <div class="card">
    <h2>或用激活码（能上网时）</h2>
    <div class="row"><input type="text" id="code" placeholder="lic_xxxxxxxx…"><button onclick="act()">激活</button></div>
  </div>
</div>
<script>
const BASE = ${JSON.stringify(base)};
const $ = id => document.getElementById(id);
let MC = '';
function fmt(o){ return JSON.stringify(o, null, 2); }
async function load(){
  try{
    const r = await fetch(BASE + '/state', { cache: 'no-store' });
    const s = await r.json();
    MC = s.machine_code || '';
    $('mc').textContent = s.machine_code || '-';
    $('scope').textContent = s.scope === 'suite' ? '全功能套件（' + (s.plugin_id||'') + ' 所在的套件证）' : (s.scope === 'plugin' ? '单插件证' : '未授权');
    $('lid').textContent = s.license_id || '-';
    $('exp').textContent = s.expires_at ? new Date(s.expires_at).toLocaleString('zh-CN') : '永久';
    $('pool').textContent = s.ticket_free ? '不限制用量（仅校验有效期）' : ((s.pool ?? 0) + ' 张（可用 ' + (s.usable ? '是' : '否') + '）'); /* WB-TICKET-FREE-UI */
    $('via').textContent = ({ own:'独立证（本插件）', suite:'套件证', auto:'自动注册' })[s.via] || s.via || '-';
    $('srv').textContent = s.server || '-';
    const b = $('badge');
    if (s.usable) { b.className = 'badge ok'; b.textContent = '已授权'; }
    else if (s.reason) { b.className = 'badge bad'; b.textContent = s.reason; }
    else { b.className = 'badge warn'; b.textContent = '未激活'; }
    $('reason').textContent = s.reason ? '原因：' + s.reason + (s.reason === 'no_ticket' ? '（票已用尽，请导入新包）' : '') : '';
  }catch(e){ $('badge').className='badge bad'; $('badge').textContent='读取失败'; $('reason').textContent=String(e); }
}
function copyMc(){ navigator.clipboard && navigator.clipboard.writeText(MC); $('reason').textContent='机器码已复制：' + MC; }
function show(t){ const l=$('log'); l.hidden=false; l.textContent = t; }
async function upload(file){
  show('上传中… ' + file.name + ' (' + (file.size/1048576).toFixed(2) + ' MB)');
  try{
    const r = await fetch(BASE + '/import', { method:'POST', headers:{'content-type':'application/octet-stream'}, body: file });
    const j = await r.json();
    show(fmt(j));
    if (j.ok) { await load(); alert('导入成功：本地票池 ' + j.pool + ' 张，到期 ' + (j.expires_at || '永久')); }
    else alert('导入失败：' + (j.message || j.error));
  }catch(e){ show(String(e)); }
}
const drop = $('drop'), file = $('file');
drop.onclick = () => file.click();
file.onchange = () => file.files[0] && upload(file.files[0]);
['dragenter','dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) upload(f); });
async function act(){
  const code = $('code').value.trim(); if(!code) return;
  const r = await fetch(BASE + '/activate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code }) });
  const j = await r.json(); show(fmt(j)); await load();
}
load();
</script></body></html>`;
}
