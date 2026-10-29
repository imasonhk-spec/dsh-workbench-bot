/* license-panel.js —— DSH 插件授权锁屏（浏览器侧，零依赖，内联进插件 client.js）
 *
 * v1.2 · 2026-10-29  ★ SILENT：默认**不再弹激活界面** ★
 *
 * 设计约束（改这个文件前必须读）：
 *  0. 【v1.2 最重要】只要 state.silent 为真（门禁 v1.2 默认），本面板**永不锁屏**。
 *     客户装完即用，看不到任何激活码输入框。这是产品决定，不是降级兜底。
 *     要恢复锁屏，需服务端/环境变量把门禁切回严格模式（DSH_LICENSE_SILENT=0）。
 *  1. 判「能不能用」只看 state.usable，**不是** state.ready。
 *     gate.state() 的 ready = !reason && !pending —— pool=0 时它依然是 true。
 *     用 ready 判会出现「界面显示已授权，一点就 403」（方案 §4.5 / 计划 F5）。
 *  2. 软门禁只允许调 /license/state（零票端点）。禁止在轮询里探业务接口 ——
 *     业务接口走 allow() 会消耗票，用户"只是开着页面"就会把票池吃空。
 *  3. 网络故障一律 fail-open：不锁屏、只提示并继续重试。
 *     平台停服/断网不该让客户以为授权丢了（T12）。
 *  4. 不 import 任何东西：由 license_build.py 直接把本文件拼进 client.js。
 *  5. 【v1.2】pool===0 不再兜底成 no_ticket —— 免票模式下 pool 恒为 0，
 *     旧兜底会把“正常可用”误判成“票已用尽”，是 v1.1 误锁屏的元凶之一。
 *
 * 用法（插件 client.js 里）：
 *   mountLicenseGate({ pluginId: 'huiwen-ppt', prefix: '/api/huiwen-ppt' });
 */
(function (global) {
  'use strict';

  var REASONS = {
    offline_no_license: { t: '本机尚未激活', d: '导入离线激活包，或输入激活码后联网激活。', act: true },
    no_ticket: { t: '本地授权票已用尽', d: '联网自动补票，或导入新的离线激活包。', act: true },
    expired: { t: '授权已到期', d: '请联系服务商续期。', act: true },
    revoked: { t: '授权已停用', d: '请联系服务商处理。', act: false },
    pending: { t: '授权正在审核', d: '审核通过后会自动解锁，无需重复操作。', act: false },
    unknown_plugin: { t: '该功能当前不可用', d: '插件未在授权平台登记，请联系服务商。', act: false },
    clock_tamper: { t: '系统时间异常', d: '请校正系统时间后重试（检测到时钟回拨）。', act: false },
    mismatch: { t: '授权与本插件不匹配', d: '导入的包/激活码不属于本插件。', act: true },
    bad_signature: { t: '授权数据校验失败', d: '请重新导入官方激活包。', act: true },
    gate_init_failed: { t: '授权运行时初始化失败', d: '请联系服务商并附上日志。', act: false },
  };

  /* 纯函数：把 state 判成 { lock, title, desc, canAct }
   * 单独抽出来是为了能在 node 里测（见 test/panel_lock.mjs）——
   * 这条判定逻辑出错的代价是"全部客户被锁"或"全部客户免费用"，值得单独的回归测试。 */
  function licenseGateDecision(state) {
    if (!state || typeof state !== 'object') {
      // 拿不到状态（网络/未插桩）→ fail-open，不锁
      return { lock: false, title: '', desc: '', canAct: false, unknown: true };
    }
    /* ★ v1.2b 顺序修正（重要）：
       旧版把 `silent === true → 不锁` 放在最前面，导致**被吊销时也不锁** ——
       客户看到的是「界面能打开、每个功能都 403」，比直接告知"已停用"更糟。
       现在：先看「是否被服务商主动停用」，是就锁；否则静默模式一律不锁。
       ⚠️ 不能用 state.lockable 当前置条件：严格模式（silent=false）下 lockable 恒为 true，
          那会把正常用户也锁掉。这里只认「吊销」这两个原因。 */
    var r0 = state.reason || '';
    if (r0 === 'revoked' || r0 === 'not_active') {
      var bm = REASONS[r0] || REASONS.revoked;
      return { lock: true, reason: r0, title: bm.t, desc: bm.d, canAct: !!bm.act };
    }
    /* 静默模式（v1.2 默认）：客户永远看不到激活界面。 */
    if (state.silent === true) {
      return { lock: false, title: '', desc: '', canAct: false, silent: true };
    }
    if (state.usable === true) return { lock: false, title: '', desc: '', canAct: false };
    /* v1.2：不再用 pool===0 兜底成 no_ticket —— 免票模式下 pool 恒 0，会把正常状态误判成
       “票已用尽”。只在明确拿到 reason 时才锁；拿不到 reason 就 fail-open。 */
    var r = state.reason || (state.pending ? 'pending' : '');
    if (!r) return { lock: false, title: '', desc: '', canAct: false, unknown: true };
    var m = REASONS[r] || { t: '授权不可用', d: '原因：' + (r || '未知') + '，请联系服务商。', act: false };
    return { lock: true, reason: r, title: m.t, desc: m.d, canAct: !!m.act };
  }

  var CSS_ID = 'dshlic-style';
  var CSS = '' +
    '.dshlic-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,.72);' +
    'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.dshlic-card{width:min(520px,92vw);background:#fff;color:#1b1f24;border-radius:14px;padding:26px 26px 20px;' +
    'box-shadow:0 24px 64px rgba(0,0,0,.36)}' +
    '.dshlic-card h3{margin:0 0 6px;font-size:18px;font-weight:600}' +
    '.dshlic-desc{color:#5b6470;margin:0 0 16px;font-size:13px}' +
    '.dshlic-mc{display:flex;align-items:center;gap:8px;background:#f4f6f8;border:1px solid #e3e7ec;' +
    'border-radius:8px;padding:8px 10px;font:12px/1.4 ui-monospace,Consolas,monospace;word-break:break-all}' +
    '.dshlic-mc b{font-weight:600;color:#0f62fe;cursor:pointer}' +
    '.dshlic-row{display:flex;gap:8px;margin-top:12px}' +
    '.dshlic-row input{flex:1;min-width:0;border:1px solid #ccd3db;border-radius:8px;padding:9px 11px;font:13px ui-monospace,monospace}' +
    '.dshlic-btn{border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;background:#0f62fe;color:#fff}' +
    '.dshlic-btn[disabled]{opacity:.55;cursor:default}' +
    '.dshlic-btn.ghost{background:#eef1f5;color:#1b1f24}' +
    '.dshlic-drop{margin-top:14px;border:1.5px dashed #ccd3db;border-radius:10px;padding:18px;text-align:center;' +
    'color:#7b8694;font-size:13px;cursor:pointer;transition:.15s}' +
    '.dshlic-drop.hot{border-color:#0f62fe;background:#f2f7ff;color:#0f62fe}' +
    '.dshlic-msg{margin-top:12px;font-size:12.5px;min-height:18px}' +
    '.dshlic-msg.err{color:#c62f2f}.dshlic-msg.ok{color:#1a7f45}' +
    '.dshlic-foot{margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#98a2ae}' +
    '.dshlic-foot a{color:#98a2ae;text-decoration:none}';

  function injectCss(doc) {
    if (doc.getElementById(CSS_ID)) return;
    var st = doc.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 挂载锁屏。返回 { refresh, destroy } —— 幂等，可重复调用。 */
  function mountLicenseGate(opts) {
    opts = opts || {};
    var win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!win) return { refresh: function () {}, destroy: function () {} };
    var doc = opts.document || win.document;
    var pluginId = String(opts.pluginId || '');
    var prefix = String(opts.prefix || ('/api/' + pluginId)).replace(/\/+$/, '');
    var base = prefix + '/license';
    var pollMs = Math.max(5000, Number(opts.pollMs || 15000));
    var onState = typeof opts.onState === 'function' ? opts.onState : null;
    var fetchImpl = opts.fetch || (win.fetch ? win.fetch.bind(win) : null);

    var mask = null, timer = null, destroyed = false, busy = false;

    function cleanup() {
      if (timer) { win.clearInterval(timer); timer = null; }
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      mask = null;
    }

    function msg(text, kind) {
      if (!mask) return;
      var m = mask.querySelector('.dshlic-msg');
      if (!m) return;
      m.textContent = text || '';
      m.className = 'dshlic-msg' + (kind ? ' ' + kind : '');
    }

    // ---- 唯一允许的自动请求：零票 state ----
    function getState() {
      if (!fetchImpl) return Promise.resolve(null);
      return fetchImpl(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin_id: pluginId }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });   // 网络故障 → null → fail-open
    }

    function post(path, body, isBinary) {
      if (!fetchImpl) return Promise.reject(new Error('no fetch'));
      var init = { method: 'POST' };
      if (isBinary) {
        init.headers = { 'content-type': 'application/octet-stream' };
        init.body = body;
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body || {});
      }
      return fetchImpl(base + (path || ''), init).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad_response' }; })
          .then(function (j) { return { status: r.status, body: j }; });
      });
    }

    function render(state) {
      var d = licenseGateDecision(state);
      if (onState) { try { onState(state, d); } catch (e) {} }
      if (!d.lock) { cleanup(); return; }
      if (mask) { // 已挂载 → 只更新文案
        var h = mask.querySelector('h3'); if (h) h.textContent = d.title;
        var p = mask.querySelector('.dshlic-desc'); if (p) p.textContent = d.desc;
        var act = mask.querySelector('.dshlic-row');
        if (act) act.style.display = d.canAct ? 'flex' : 'none';
        var drop = mask.querySelector('.dshlic-drop');
        if (drop) drop.style.display = d.canAct ? 'block' : 'none';
        return;
      }
      injectCss(doc);
      mask = el(doc, 'div', 'dshlic-mask');
      var card = el(doc, 'div', 'dshlic-card');
      card.appendChild(el(doc, 'h3', null, d.title));
      card.appendChild(el(doc, 'p', 'dshlic-desc', d.desc));

      // 机器码：现场报障的唯一凭据，必须可一键复制
      var mc = el(doc, 'div', 'dshlic-mc');
      mc.appendChild(el(doc, 'span', null, '机器码'));
      var code = el(doc, 'b', null, (state && state.machine_code) || '读取中…');
      code.title = '点击复制完整机器码';
      code.onclick = function () {
        var full = (state && state.hwid) || '';
        try {
          if (win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(full);
          else {
            var ta = doc.createElement('textarea');
            ta.value = full; doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); doc.body.removeChild(ta);
          }
          msg('机器码已复制', 'ok');
        } catch (e) { msg('复制失败，请手动记录：' + full, 'err'); }
      };
      mc.appendChild(code);
      card.appendChild(mc);

      // 激活码
      var row = el(doc, 'div', 'dshlic-row');
      if (!d.canAct) row.style.display = 'none';
      var inp = el(doc, 'input');
      inp.placeholder = '输入激活码（lic_…）';
      inp.autocomplete = 'off';
      var btn = el(doc, 'button', 'dshlic-btn', '激活');
      btn.onclick = function () {
        var v = String(inp.value || '').trim();
        if (!v || busy) return;
        busy = true; btn.disabled = true; msg('正在激活…');
        post('/activate', { code: v }).then(function (r) {
          var st = (r.body && r.body.state) || r.body || {};
          if (r.body && r.body.ok) { msg('激活成功', 'ok'); render(st); }
          else msg('激活失败：' + ((st && st.reason) || (r.body && r.body.error) || '未知原因'), 'err');
        }).catch(function (e) { msg('激活请求失败：' + (e && e.message), 'err'); })
          .then(function () { busy = false; btn.disabled = false; });
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
      row.appendChild(inp); row.appendChild(btn);
      card.appendChild(row);

      // 离线包拖拽
      var drop = el(doc, 'div', 'dshlic-drop', '把 .licpack 激活包拖到这里，或点击选择文件');
      if (!d.canAct) drop.style.display = 'none';
      var file = el(doc, 'input');
      file.type = 'file'; file.accept = '.licpack,application/octet-stream'; file.style.display = 'none';
      function doImport(f) {
        if (!f || busy) return;
        busy = true; msg('正在导入 ' + f.name + '…');
        var rd = new win.FileReader();
        rd.onload = function () {
          post('/import', rd.result, true).then(function (r) {
            var b = r.body || {};
            if (b.ok) {
              msg('导入成功：' + (b.via === 'suite' ? '套件证' : '插件证') + '，可用票 ' + (b.pool != null ? b.pool : '?'), 'ok');
              refresh();
            } else msg('导入失败：' + (b.message || b.error || '未知原因'), 'err');
          }).catch(function (e) { msg('导入请求失败：' + (e && e.message), 'err'); })
            .then(function () { busy = false; });
        };
        rd.readAsArrayBuffer(f);
      }
      drop.onclick = function () { file.click(); };
      file.onchange = function () { doImport(file.files && file.files[0]); };
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
      });
      drop.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        doImport(f);
      });
      card.appendChild(drop);
      card.appendChild(file);

      card.appendChild(el(doc, 'div', 'dshlic-msg'));
      var foot = el(doc, 'div', 'dshlic-foot');
      foot.appendChild(el(doc, 'span', null, pluginId + ' · ' + ((state && state.server) || '')));
      var retry = el(doc, 'a', null, '刷新状态');
      retry.href = 'javascript:void(0)';
      retry.onclick = function () { refresh(); };
      foot.appendChild(retry);
      card.appendChild(foot);

      mask.appendChild(card);
      (doc.body || doc.documentElement).appendChild(mask);
    }

    function refresh() {
      if (destroyed) return Promise.resolve(null);
      return getState().then(function (st) { if (!destroyed) render(st); return st; });
    }

    function startPolling() {
      if (timer) return;
      timer = win.setInterval(function () {
        // 页面不可见时不轮询：既省请求，也避免后台标签页被打断后误判
        if (doc.visibilityState === 'hidden') return;
        refresh();
      }, pollMs);
    }

    startPolling();
    refresh();

    return {
      refresh: refresh,
      destroy: function () { destroyed = true; cleanup(); },
    };
  }

  var api = { mountLicenseGate: mountLicenseGate, licenseGateDecision: licenseGateDecision, REASONS: REASONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.mountLicenseGate = mountLicenseGate, global.licenseGateDecision = licenseGateDecision;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
