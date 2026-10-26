// license-gate.mjs —— DSH 插件授权运行时（vendored，随插件分发）
// v1.1 · 2026-10-26
//
// 来源：@local/dsh-workbench 线上部署版（index.js，minified）的 Ed25519 票池门禁，
//       抽成单文件 + 补齐「独立安装 / 组合使用」双形态 + O2 离线激活包导入。
//
// 三条硬约束（改这个文件前必须读）：
//   L-A 自足：禁止 import @local/dsh-workbench；一切依赖只用 node 内置模块。
//   L-B 收敛：解析顺序 suite → own → lease → env → autoRegister，命中即停；
//             同机多插件共享一张证，客户只需激活一次。
//   L-C 隔离：authorization subject 共享，但账本（pool/seq/心跳）按插件分片，
//             每个插件一个状态文件，绝不共写。
//
// 与线上 workbench 版的差异（共 8 处）：
//   1) covers(lic) 支持 plugin_id==='*'（套件证）
//   2) 双状态文件（own / suite），按插件分片
//   3) lease.json 共享租约缓存
//   4) 五级解析链 resolve()
//   5) autoRegister 成功后登记租约
//   6) 心跳合并（同证 55s 内只打一次）
//   7) state() 增加 via/scope/license_id/hwid/machine_code
//   8) importPack() 导入 O2 离线激活包（全程不联网）
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PUB_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgbkbnNduRwrgAtI9lpc3OLfxzJOrMoZMEtw8RHg+4gE=
-----END PUBLIC KEY-----`;
const TICKET_DOMAIN = 'dsh-ticket/v1\n';
const DEVICE_DOMAIN = 'dsh-device/v1\n';
const PACK_DOMAIN = 'dsh-pack/v1\n';
const PACK_MAGIC = 'DSH-LICPACK';
const LICENSE_FIELDS = ['v', 'license_id', 'plugin_id', 'client_id', 'hwid', 'issued_at', 'expires_at', 'max_ops', 'used_ops', 'status'];
const TICKET_FIELDS = ['v', 'lid', 'pid', 'cid', 'hwid', 'seq', 'iat', 'exp'];
const SERVER = (process.env.DSH_LICENSE_SERVER || 'https://sync.ilica.cn').replace(/\/+$/, '');
const CLOCK_SKEW_MS = 600_000;
const MAX_PACK_BYTES = 64 * 1024 * 1024;

// ---- canonical JSON：递归按 key 排序（必须与服务端 sign.js 完全一致）----
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf-8').digest('hex');
// ⚠️ 状态文件名必须用 sha1（与线上 workbench 门禁一致）；换成 sha256 会"找不到已有状态 → 重复注册"
const sha1 = s => crypto.createHash('sha1').update(String(s), 'utf-8').digest('hex');
const b64e = o => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64');
const b64d = s => JSON.parse(Buffer.from(s, 'base64').toString('utf-8'));

let _pub = null;
const pubKey = () => (_pub ||= crypto.createPublicKey(PUB_PEM));

function verifySig(obj, domain = '') {
  if (!obj || typeof obj !== 'object') return false;
  const { sig, ...rest } = obj;
  if (!sig) return false;
  try {
    return crypto.verify(null, Buffer.from(domain + canonical(rest), 'utf-8'), pubKey(), Buffer.from(sig, 'base64'));
  } catch { return false; }
}
const isLicense = o => !!o && o.v === 1 && LICENSE_FIELDS.every(k => k in o) && verifySig(o);
const isTicket = o => !!o && o.v === 1 && TICKET_FIELDS.every(k => k in o) && verifySig(o, TICKET_DOMAIN) && o.exp > 0;

// 诊断用：离线校验任意 license / ticket / pack blob（排障脚本可直接用，不发请求）
export const verifyLicenseBlob = (o) => isLicense(o);
export const verifyTicketBlob = (o) => isTicket(o);
export const machineHwid = () => hwid();

// ---- 设备身份 ----
function hwid() {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/sys/class/dmi/id/product_uuid']) {
    try {
      const v = fs.readFileSync(f, 'utf-8').trim();
      if (v && v.length >= 8) return sha256('mid:' + v.toLowerCase());
    } catch {}
  }
  const cpus = os.cpus();
  return sha256('fallback:' + os.hostname() + '|' + (cpus[0] && cpus[0].model || '') + '|' + os.userInfo().username);
}

function deviceKeys(dir) {
  const kf = path.join(dir, 'dev.key'), pf = path.join(dir, 'dev.pub');
  try {
    return { priv: crypto.createPrivateKey(fs.readFileSync(kf, 'utf-8')), pubPem: fs.readFileSync(pf, 'utf-8') };
  } catch {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(kf, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pf, publicKey.export({ type: 'spki', format: 'pem' }));
    return { priv: privateKey, pubPem: fs.readFileSync(pf, 'utf-8') };
  }
}

// ---- 时钟（防回拨）----
class Clock {
  constructor(file) { this.file = file; this.maxSeen = this.#load(); this.skew = 0; this.last = 0; }
  #load() { try { const n = Number(fs.readFileSync(this.file, 'utf-8')); return Number.isFinite(n) ? n : 0; } catch { return 0; } }
  #save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, String(this.maxSeen)); } catch {} }
  observe(now = Date.now()) {
    if (now > this.maxSeen) { this.maxSeen = now; if (now - this.last > 3_600_000) { this.last = now; this.#save(); } return false; }
    return this.maxSeen - now > CLOCK_SKEW_MS;   // 回拨判定
  }
  calibrate(iso) { const t = new Date(iso).getTime(); if (Number.isFinite(t)) this.skew = t - Date.now(); }
  now() { return Date.now() + this.skew; }
}

// ---- 门禁 ----
export function createGate({ pluginId, dataDir, poolTarget = 100, lowWater = 10, logger = () => {}, server = SERVER, hwid: hwidOverride } = {}) {
  const dir = dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.cache', '.s');
  const hw = hwidOverride || hwid();        // hwidOverride 仅供单测/排障，生产勿传
  const clock = new Clock(path.join(dir, '.clock'));
  const gate = { pluginId, hwid: hw, server };

  let key = null, lic = null, pool = [], maxUsedSeq = 0, ackedSeq = 0;
  let reason = null, pending = false, ready = null, hb = null, dev = null;
  let kindUsed = 'own';                                     // 'own' | 'suite'
  let stateFile = path.join(dir, stateFileName('own'));
  // 代际号：importPack 会整体替换 lic/pool，任何"在途"的网络流程（register/bootstrap/refill/sync）
  // 回来时若代际已变，必须丢弃自己的写入，否则会用空数据覆盖刚导入的离线包。
  let epoch = 0;
  const stale = (g) => g !== epoch;

  // ---- L-A/L-B：覆盖判定 + 分片状态文件 ----
  const covers = (l) => !!l && (l.plugin_id === pluginId || l.plugin_id === '*');
  function stateFileName(kind) { return sha1(kind === 'suite' ? pluginId + ':suite' : pluginId).slice(0, 8) + '.json'; }
  function fileOf(kind) { return path.join(dir, stateFileName(kind)); }

  // ---- 共享租约缓存（只是提示缓存，丢了能自愈）----
  const leaseFile = path.join(dir, 'lease.json');
  function readLease() { try { return JSON.parse(fs.readFileSync(leaseFile, 'utf-8')) || {}; } catch { return {}; } }
  function writeLease(patch) {
    try {
      const cur = readLease();
      const next = { ...cur, ...patch, keys: { ...(cur.keys || {}), ...(patch.keys || {}) }, updated_at: new Date().toISOString() };
      const tmp = leaseFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, leaseFile);          // 原子替换，避免读到半截
    } catch {}
  }

  // ---- 落盘：save() 立即写；persist() 节流写 ----
  // 为什么节流：allow() 每消耗一张票都会改写状态文件，而文件里装着**剩余全部票**。
  // 1 万票的池子约 3.5MB，若每票都写一次 = O(n²) 的 I/O（几十 GB），NAS 的 eMMC 上会卡死。
  // 代价：极端掉电最多丢最近 PERSIST_MIN_MS 内消耗的票（票是"燃料"不是计费单位，
  //       且丢的票只是可再用一次，不影响授权边界），因此可接受。
  const PERSIST_MIN_MS = Number(process.env.DSH_LICENSE_PERSIST_MS || 1500);
  let dirty = false, lastSave = 0, saveTimer = null;
  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, b64e({ key, lic, maxUsedSeq, ackedSeq, pool }));
      fs.renameSync(tmp, stateFile);          // 原子替换，掉电不会读到半截文件
      dirty = false; lastSave = Date.now();
    } catch (e) { logger('persist failed', e && e.message); }
  }
  function persist() {
    dirty = true;
    if (Date.now() - lastSave >= PERSIST_MIN_MS) return save();
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; if (dirty) save(); }, PERSIST_MIN_MS);
      if (saveTimer.unref) saveTimer.unref();
    }
  }
  // ⚠️ 设备签名必须用「本次请求实际携带的那把 key」——不能无条件用闭包里的 key。
  // 原因：tryKey(k) 是**建立 key 的那一步**，此时闭包 key 还是 null；
  // 老实现 `if (!key) return null` 会让 tryKey 发出的请求**不带设备签名**，
  // 而服务端一旦绑定过 dev_pub（第一个插件注册时就绑了）就会回 403 bad_device_sig →
  // 租约(lease.json)/环境变量/套件 key 这三条解析路径**永远失败** →
  // 同机第二个插件静默 autoRegister 出一张自己的证，L-B「只激活一次」被击穿（S3 失败）。
  const devAuth = (kOverride) => {
    const k = kOverride || key;
    if (!k) return null;
    dev ||= deviceKeys(dir);
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = DEVICE_DOMAIN + k + '\n' + pluginId + '\n' + hw + '\n' + nonce;
    return { devPub: dev.pubPem, nonce, devSig: crypto.sign(null, Buffer.from(payload, 'utf-8'), dev.priv).toString('base64') };
  };
  // ⚠️ 设备字段必须**扁平**放进 body：服务端只读顶层 b.dev_pub / b.nonce / b.dev_sig
  const devBody = (kOverride) => { const d = devAuth(kOverride); return d ? { dev_pub: d.devPub, nonce: d.nonce, dev_sig: d.devSig } : {}; };
  async function post(p, token, body) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      const r = await fetch(server + p, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
      const txt = await r.text();
      let data = null; try { data = JSON.parse(txt); } catch {}
      return { status: r.status, data };
    } finally { clearTimeout(t); }
  }
  const absorb = (tickets) => {
    const have = new Set(pool.map(t => t.seq));
    for (const t of tickets || []) if (t.seq > maxUsedSeq && !have.has(t.seq)) { pool.push(t); have.add(t.seq); }
    pool.sort((a, b) => a.seq - b.seq);
  };
  // 网络类原因：本机已有证（离线包/已落盘）时不该因"连不上"就关门 —— 离线包是自足授权
  const NET_REASONS = new Set(['offline_no_license', 'unavailable', 'register_failed', 'rate_limited']);
  const close = (r) => {
    if (reason || r === 'no_ticket') return;
    if (lic && NET_REASONS.has(r)) { logger('net issue ignored (local license present)', r); return; }
    reason = r; logger('gate closed', r);
  };
  const realign = () => {                        // 多实例/离线包导入后水位对齐
    if (!pool.length) return;
    let min = null;
    for (const t of pool) if (t.seq > maxUsedSeq && (min === null || t.seq < min)) min = t.seq;
    if (min !== null && min > maxUsedSeq + 1) { maxUsedSeq = min - 1; save(); }
  };

  async function doInit() { return resolve(); }

  // ---- L-B：五级解析链（套件优先 / 到期更晚者优先）----
  async function resolve() {
    // ①② 本地状态文件：own / suite 两个候选，都合法时选「证到期更晚」的那个
    //    （否则客户先领 7 天试用套件、再导入 1 年离线包，会一直用短的那张）
    const cands = [];
    for (const kind of ['suite', 'own']) {
      try {
        const saved = b64d(fs.readFileSync(fileOf(kind), 'utf-8'));
        if (!saved || !isLicense(saved.lic) || !covers(saved.lic)) continue;
        // 换机（状态文件是从别的机器拷来的）→ 不认这份文件，继续往下走注册/离线激活
        if (saved.lic.hwid && saved.lic.hwid !== hw) { logger('state hwid mismatch, skipped', kind); continue; }
        cands.push({ kind, saved });
      } catch {}
    }
    if (cands.length) {
      cands.sort((a, b) => {
        const ea = a.saved.lic.expires_at ? new Date(a.saved.lic.expires_at).getTime() : Infinity;
        const eb = b.saved.lic.expires_at ? new Date(b.saved.lic.expires_at).getTime() : Infinity;
        if (eb !== ea) return eb - ea;
        return a.kind === 'suite' ? -1 : 1;      // 同到期 → 套件优先
      });
      const pick = cands[0];
      lic = pick.saved.lic; key = pick.saved.key || key; kindUsed = pick.kind;
      stateFile = fileOf(pick.kind);
      maxUsedSeq = pick.saved.maxUsedSeq || 0; ackedSeq = pick.saved.ackedSeq || 0;
      pool = (pick.saved.pool || []).filter(isTicket);
      await sync();
      return;
    }
    // ③ 共享租约缓存
    const lease = readLease();
    for (const k of [lease.suite_key, (lease.keys || {})[pluginId]].filter(Boolean)) {
      if (await tryKey(k)) return;
    }
    // ④ 环境变量
    if (process.env.DSH_LICENSE_KEY && await tryKey(String(process.env.DSH_LICENSE_KEY).trim())) return;
    // ⑤ 自动注册
    return autoRegister();
  }

  // 用候选 key 试领 1 张票，成功即认领这张证
  async function tryKey(k) {
    const g = epoch;
    try {
      const { status, data } = await post('/api/client/tickets', k, { hwid: hw, plugin_id: pluginId, want: 1, ...devBody(k) });
      if (status !== 200 || !data || !data.ok || !isLicense(data.license)) return false;
      if (!covers(data.license)) return false;             // 别人的证，别捡
      if (stale(g)) return false;                           // 期间导入过离线包，让位
      key = k; lic = data.license;
      kindUsed = lic.plugin_id === '*' ? 'suite' : 'own';
      stateFile = fileOf(kindUsed);
      absorb(data.tickets); save(); heartbeat();
      writeLease(kindUsed === 'suite' ? { suite_key: k } : { keys: { [pluginId]: k } });
      return true;
    } catch { return false; }
  }

  async function autoRegister() {
    const g = epoch;
    try {
      dev ||= deviceKeys(dir);
      const nonce = crypto.randomBytes(16).toString('hex');
      const payload = pluginId + '\n' + hw + '\n' + nonce;
      const sig = crypto.sign(null, Buffer.from(payload, 'utf-8'), dev.priv).toString('base64');
      const { status, data } = await post('/api/client/register', null, { plugin_id: pluginId, hwid: hw, nonce, sig, dev_pub: dev.pubPem });
      if (stale(g)) return;                                   // 期间导入过离线包，让位
      if (status === 200 && data && data.ok && data.approved && data.activation_code) {
        key = data.activation_code;
        if (isLicense(data.license)) lic = data.license;
        kindUsed = 'own'; stateFile = fileOf('own');
        writeLease({ keys: { [pluginId]: key } });
        return bootstrap();
      }
      if (status === 200 && data && data.approved === false) { pending = true; return; }
      close(status === 404 ? 'unknown_plugin' : status === 429 ? 'rate_limited' : 'register_failed');
    } catch { close('offline_no_license'); }
  }
  async function bootstrap() {
    const g = epoch;
    try {
      const { status, data } = await post('/api/client/tickets', key, { hwid: hw, plugin_id: pluginId, want: poolTarget, ...devBody() });
      if (data && data.server_time) clock.calibrate(data.server_time);
      if (status !== 200 || !data) return close('unavailable');
      if (!data.ok) return close(data.status === 'disabled' ? 'revoked' : (data.status || 'unavailable'));
      if (stale(g)) return;                                   // 期间导入过离线包，让位
      if (isLicense(data.license)) lic = data.license;
      absorb(data.tickets);
      save();
    } catch { close('offline_no_license'); }
  }
  // 补票并发合并。
  // 老实现用 `busy` 布尔做重入保护，第二次调用会**立刻** return false ——
  // 而 allow() 在池空时会 `await refill()` 后马上判断"还是没票" → 误报 no_ticket。
  // 触发条件很日常：allow() 消费掉最后一张票后 fire-and-forget 触发一次 refill，
  // 紧接着的下一次 allow() 正好撞在飞行中，就会在"票还能补到"的情况下被拒。
  // 改为共享同一次请求的 promise：并发的调用者等同一个结果，而不是各自拿 false。
  let refillP = null;
  function refill() {
    if (!key) return Promise.resolve(false);
    if (refillP) return refillP;
    refillP = doRefill().finally(() => { refillP = null; });
    return refillP;
  }
  async function doRefill() {
    const g = epoch;
    try {
      const { status, data } = await post('/api/client/tickets', key, {
        hwid: hw, plugin_id: pluginId, want: poolTarget,
        ops_used: maxUsedSeq - ackedSeq, acked_seq: maxUsedSeq, ...devBody(),
      });
      if (data && data.server_time) clock.calibrate(data.server_time);
      if (status !== 200 || !data) return false;
      if (!data.ok) { close(data.status === 'disabled' ? 'revoked' : (data.status || 'unavailable')); return false; }
      if (stale(g)) return false;                             // 期间导入过离线包，让位
      if (isLicense(data.license)) lic = data.license;
      absorb(data.tickets);
      ackedSeq = Math.max(ackedSeq, maxUsedSeq);
      save();
      return (data.tickets || []).length > 0;
    } catch { return false; }
  }
  async function sync() {
    if (!key) return false;
    const g = epoch;
    try {
      const { data } = await post('/api/client/refresh', key, {
        hwid: hw, plugin_id: pluginId, ops_used: maxUsedSeq - ackedSeq, acked_seq: maxUsedSeq, ...devBody(),
      });
      if (data && data.server_time) clock.calibrate(data.server_time);
      if (data && data.status === 'disabled') { close('revoked'); return false; }
      if (stale(g)) return false;                             // 期间导入过离线包，让位
      if (data && data.license) { if (!isLicense(data.license)) { close('bad_signature'); return false; } lic = data.license; }
      ackedSeq = Math.max(ackedSeq, maxUsedSeq);
      save();
      return true;
    } catch { return false; }
  }
  // 心跳合并：同一张证 55s 内只打一次（8 插件同证时把请求量压到 1/8）
  const hbFile = path.join(dir, '.hb');
  function hbDue(lid) {
    try { const j = JSON.parse(fs.readFileSync(hbFile, 'utf-8')); return !(j[lid] && Date.now() - j[lid] < 55_000); }
    catch { return true; }
  }
  function hbMark(lid) {
    try {
      let j = {}; try { j = JSON.parse(fs.readFileSync(hbFile, 'utf-8')); } catch {}
      j[lid] = Date.now();
      const tmp = hbFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, hbFile);
    } catch {}
  }
  function heartbeat() {
    if (hb) return;
    hb = setInterval(async () => {
      const lid = lic && lic.license_id;
      if (lid && !hbDue(lid)) return;
      try { await init(); await sync(); if (lid) hbMark(lid); } catch {}
    }, 60_000);
    if (hb.unref) hb.unref();
  }
  const init = () => (ready ||= doInit().finally(heartbeat).catch((e) => {
    logger('init failed', e && e.message); close('unavailable');
  }));

  // ---- O2 离线激活包：解析 / 校验 / 导入（全程零网络）----
  function parsePack(input) {
    let buf = input;
    if (typeof buf === 'string') {
      const s = buf.trim();
      if (s.startsWith('{')) return JSON.parse(s);              // 直接给 JSON 文本
      buf = Buffer.from(s, 'base64');                           // 或 base64
    }
    if (!Buffer.isBuffer(buf)) {
      if (buf && typeof buf === 'object') return buf;            // 已解析对象
      throw new Error('pack must be Buffer/string/object');
    }
    if (buf.length > MAX_PACK_BYTES) throw new Error('pack too large');
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return JSON.parse(buf.toString('utf-8'));
  }
  function validatePack(pack) {
    if (!pack || pack.magic !== PACK_MAGIC) return { ok: false, error: 'bad_magic', message: '不是 DSH 离线激活包' };
    if (pack.v !== 1) return { ok: false, error: 'bad_version', message: '激活包版本不支持（需 v1）' };
    if (!pack.sig) return { ok: false, error: 'no_sig', message: '激活包缺少签名' };
    const payload = {
      magic: pack.magic, v: pack.v, created_at: pack.created_at, note: pack.note || '',
      hwid: pack.hwid, license_id: pack.license && pack.license.license_id,
      plugin_id: pack.license && pack.license.plugin_id,
      activation_key: pack.activation_key, counts: pack.counts, digest: pack.digest,
    };
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(PACK_DOMAIN + canonical(payload), 'utf-8'), pubKey(), Buffer.from(pack.sig, 'base64')); } catch {}
    if (!ok) return { ok: false, error: 'bad_sig', message: '激活包签名校验失败（文件被改动或非官方签发）' };
    // 摘要：先拒掉被截断/替换的票数组，避免逐张验 1 万次
    let digest = '';
    try { digest = sha256(canonical(pack.tickets)); } catch {}
    if (digest !== pack.digest) return { ok: false, error: 'digest_mismatch', message: '激活包内容不完整（票被截断或改动）' };
    if (!isLicense(pack.license)) return { ok: false, error: 'bad_license_sig', message: '授权证签名无效' };
    if (!covers(pack.license)) return { ok: false, error: 'plugin_mismatch', message: '该激活包不包含本插件（' + pluginId + '）' };
    if (pack.license.hwid !== hw || (pack.hwid && pack.hwid !== hw)) {
      return { ok: false, error: 'hwid_mismatch', message: '激活包绑定的另一台机器，本机机器码 ' + hw.slice(0, 16) };
    }
    if (pack.license.status !== 'active') return { ok: false, error: 'not_active', message: '授权已停用：' + pack.license.status };
    const exp = pack.license.expires_at ? new Date(pack.license.expires_at).getTime() : Infinity;
    if (exp <= clock.now()) return { ok: false, error: 'expired', message: '激活包已过期（' + pack.license.expires_at + '）' };
    const arr = (pack.tickets || {})[pluginId];
    if (!Array.isArray(arr) || !arr.length) return { ok: false, error: 'no_tickets', message: '激活包里没有本插件的票' };
    if (pack.counts && pack.counts[pluginId] != null && Number(pack.counts[pluginId]) !== arr.length) {
      return { ok: false, error: 'count_mismatch', message: '票数与声明不一致' };
    }
    // 逐张验签（1 万张 ≈ 百毫秒级）+ 绑定校验
    let bad = null;
    for (const t of arr) {
      if (!isTicket(t)) { bad = { error: 'bad_ticket_sig', seq: t && t.seq }; break; }
      if (t.pid !== pluginId || (t.lid && t.lid !== pack.license.license_id) || (t.hwid && t.hwid !== hw)) {
        bad = { error: 'ticket_mismatch', seq: t.seq }; break;
      }
      if (t.exp <= clock.now()) { bad = { error: 'ticket_expired', seq: t.seq }; break; }
    }
    if (bad) return { ok: false, ...bad, message: '票校验失败（seq=' + bad.seq + '）' };
    return { ok: true, count: arr.length, tickets: arr };
  }

  gate.importPack = async (input) => {
    epoch += 1;                    // 让在途的 register/refill/sync 回来时让位，别覆盖刚导入的包
    // 等一次 init 收尾（离线时是快速失败；网络被黑洞时最多等 2.5s，不阻塞现场导入）
    await Promise.race([init().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    let pack, v;
    try {
      pack = parsePack(input);
      v = validatePack(pack);
    } catch (e) {
      return { ok: false, error: 'parse_failed', message: '激活包解析失败：' + (e && e.message ? e.message : String(e)) };
    }
    if (!v.ok) return v;

    const kind = pack.license.plugin_id === '*' ? 'suite' : 'own';
    const targetFile = fileOf(kind);
    let base = null;
    try { base = b64d(fs.readFileSync(targetFile, 'utf-8')); } catch {}
    const sameLic = !!(base && base.lic && base.lic.license_id === pack.license.license_id);
    const baseSeq = sameLic ? (base.maxUsedSeq || 0) : 0;      // 已消耗水位：票必须在此之上

    // 合并：同一张证 → 累加票、保留水位；不同证 → 换证重来（旧票属旧证，必须丢弃）
    const incoming = v.tickets;
    const merged = sameLic
      ? (base.pool || []).filter(isTicket).concat(incoming)
      : incoming.slice();
    const seen = new Set();
    const dedup = [];
    for (const t of merged) {
      if (!t || t.lid !== pack.license.license_id) continue;   // 只留本证的票
      if (t.seq <= baseSeq) continue;                            // 已消耗过的票不能"复活"
      if (seen.has(t.seq)) continue;                            // 重复导入去重
      seen.add(t.seq); dedup.push(t);
    }
    dedup.sort((a, b) => a.seq - b.seq);
    if (!dedup.length) return { ok: false, error: 'no_usable_ticket', message: '没有可用的票（可能全部已过期或已用）' };

    kindUsed = kind;
    stateFile = targetFile;
    lic = pack.license;
    key = (pack.activation_key || (sameLic ? base.key : null) || key || null);
    maxUsedSeq = baseSeq;
    ackedSeq = sameLic ? (base.ackedSeq || 0) : 0;
    pool = dedup;
    reason = null; pending = false;
    realign();          // 离线包的 seq 可能不从 1 开始（同一张证多次导出），对齐水位
    save();
    writeLease(kind === 'suite' ? { suite_key: key } : { keys: { [pluginId]: key } });
    logger('pack imported', { kind, pool: pool.length, via: key ? 'key+pack' : 'pack' });
    return {
      ok: true, via: kind, scope: kind === 'suite' ? 'suite' : 'plugin',
      plugin_id: pluginId, license_id: lic.license_id, expires_at: lic.expires_at,
      imported: incoming.length, pool: pool.length, activation_key: !!key,
    };
  };

  // ---- 对外 API ----
  gate.allow = async () => {                      // 硬门禁：消耗一张票
    await init();
    if (pending) return deny('pending');
    if (reason) return deny(reason);
    if (clock.observe()) { close('clock_tamper'); return deny('clock_tamper'); }
    realign();
    let idx = pool.findIndex(t => t.seq === maxUsedSeq + 1);
    if (idx < 0) { await refill(); realign(); idx = pool.findIndex(t => t.seq === maxUsedSeq + 1); }
    if (idx < 0) return deny('no_ticket');
    const t = pool[idx];
    if (!isTicket(t)) { close('bad_signature'); return deny('bad_signature'); }
    if (t.pid !== pluginId || (t.hwid && t.hwid !== hw) || (t.lid && lic && t.lid !== lic.license_id)) { close('mismatch'); return deny('mismatch'); }
    if (clock.now() >= t.exp) { pool.splice(idx, 1); persist(); return gate.allow(); }  // 过期票丢弃重试
    pool.splice(idx, 1); maxUsedSeq = t.seq;
    if (pool.length === 0) save(); else persist();
    if (pool.length < lowWater) refill().catch(() => {});
    return { allowed: true };
  };
  // 软门禁：不消耗票。⚠️ 判断"能不能用"必须同时看 ready && pool>0（线上版 ready 在 pool=0 时仍为 true）
  gate.state = async () => {
    await init();                                   // doInit 内部全 catch，不会抛
    return {
      ready: !reason && !pending, pending, usable: !reason && !pending && pool.length > 0,
      plugin_id: pluginId, via: kindUsed, scope: lic ? (lic.plugin_id === '*' ? 'suite' : 'plugin') : null,
      license_id: lic ? lic.license_id : null, status: lic ? lic.status : null,
      expires_at: lic ? lic.expires_at : null, pool: pool.length, reason,
      hwid: hw, machine_code: hw.slice(0, 16), server,
    };
  };
  // 激活码入口（/license/activate 与锁屏都走这里）
  // ⚠️ 必须先 tryKey(k)：resolve() 的五级链（state 文件 → lease → env → autoRegister）
  // **完全不读 key 变量**。若直接 init()，用户输入的激活码会被静默忽略，一路走到
  // autoRegister 注册出一张全新的自动证 —— 现场表现是"激活码输对了但状态没变成客户买的那张"，
  // 而且因为自动证也能用，问题会被掩盖成"授权好像生效了"。
  gate.activate = async (code) => {
    const k = String(code || '').trim();
    ready = null; reason = null; pending = false; key = k;
    if (k) { try { await tryKey(k); } catch {} }
    return init().then(() => gate.state());
  };
  gate.flush = () => save();                       // 进程退出前显式落盘（persist 是节流的）
  gate.deny = (res, g) => {
    const body = { error: 'FEATURE_UNAVAILABLE', code: g.code, reason: g.reason, message: g.message, actions: g.actions || ['activate'] };
    try { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); } catch {}
  };
  return gate;
}

// node 内置模块延迟加载（ESM 静态 import 也能用，这里只是把 zlib 的加载推迟到真正需要时）

const MESSAGES = {
  hwid_mismatch: { code: 'E_ENV_CHANGED', msg: '运行环境已变更，请联系服务商重置授权' },
  device_mismatch: { code: 'E_ENV_CHANGED', msg: '运行环境已变更，请联系服务商重置授权' },
  clock_tamper: { code: 'E_ENV_INVALID', msg: '运行环境异常，请校正系统时间后重试' },
  pending: { code: 'E_FEATURE_PENDING', msg: '授权正在审核，请稍候' },
  revoked: { code: 'E_FEATURE_REVOKED', msg: '授权已停用，请联系服务商', actions: [] },
  unknown_plugin: { code: 'E_FEATURE_UNAVAILABLE', msg: '该功能当前不可用，请联系服务商', actions: [] },
  expired: { code: 'E_FEATURE_EXPIRED', msg: '授权已到期，请联系服务商续期' },
  offline_no_license: { code: 'E_FEATURE_OFFLINE', msg: '本机尚未激活且无法连接授权服务器，请导入离线激活包', actions: ['import'] },
  no_ticket: { code: 'E_FEATURE_OFFLINE', msg: '本地授权票已用尽，请联网或导入新的离线激活包', actions: ['import'] },
};
function deny(reason) {
  const m = MESSAGES[reason] || { code: 'E_FEATURE_UNAVAILABLE', msg: '该功能当前不可用，请联系服务商' };
  return { allowed: false, reason, code: m.code, message: m.msg, actions: m.actions || ['activate'] };
}
