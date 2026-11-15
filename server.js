'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const DB = require('./lib/db');
const metrics = require('./lib/metrics');
const alert = require('./lib/alert');
const probe = require('./lib/probe');
const mailer = require('./lib/mailer');
const paths = require('./lib/paths');
const { spawn } = require('child_process');

const ROOT = paths.ROOT;
const VERSION = '1.5.1';
const CONFIG_FILE = paths.CONFIG_FILE;
const DATA_DIR = paths.DATA_DIR;
const PUBLIC_DIR = paths.PUBLIC_DIR;

// 隐藏窗口启动时进程没有可见控制台, 日志必须由自己落盘。
// 旧版靠 cmd 的 ">> server.log" 重定向: 句柄被独占后重启写不进日志,
// 而重定向本身失败(目录只读)时错误也随隐藏窗口一起消失。
(function teeLog() {
  let stream;
  try {
    // Win7 的记事本只有见到 BOM 才按 UTF-8 解码, 否则中文日志全是乱码。
    const fresh = !fs.existsSync(paths.LOG_FILE) || fs.statSync(paths.LOG_FILE).size === 0;
    stream = fs.createWriteStream(paths.LOG_FILE, { flags: 'a' });
    if (fresh) stream.write('\ufeff');
  } catch (e) { return; }
  stream.on('error', () => {});
  const util = require('util');
  for (const kind of ['log', 'error', 'warn']) {
    const orig = console[kind].bind(console);
    console[kind] = function () {
      const line = util.format.apply(null, arguments);
      try { stream.write('[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + line + '\n'); } catch (e) {}
      orig.apply(null, arguments);
    };
  }
})();

const DEFAULT_CONFIG = {
  server: { host: '0.0.0.0', port: 8686, local_name: '', open_browser: true },
  agent: { server_url: 'http://127.0.0.1:8686', token: '', interval_sec: 15, hostname: '', name: '' },
  collection: { interval_sec: 15, slow_interval_sec: 30 },
  retention_days: 7,
  token: '',
  webhook_url: '',
  mail: { enabled: false, host: '', port: 465, secure: 'ssl', user: '', pass: '', from: '', to: '' },
};

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('config.json 解析失败, 使用默认配置:', e.message); }
  } else {
    paths.writeQuiet(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  return {
    server: { ...DEFAULT_CONFIG.server, ...cfg.server },
    agent: { ...DEFAULT_CONFIG.agent, ...cfg.agent },
    collection: { ...DEFAULT_CONFIG.collection, ...cfg.collection },
    retention_days: cfg.retention_days == null ? DEFAULT_CONFIG.retention_days : cfg.retention_days,
    token: cfg.token == null ? '' : cfg.token,
    webhook_url: cfg.webhook_url == null ? '' : cfg.webhook_url,
    mail: { ...DEFAULT_CONFIG.mail, ...(cfg.mail || {}) },
  };
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('配置保存失败(' + (e.code || e.message) + '): ' + CONFIG_FILE); throw e; }
}

if (paths.redirected) {
  console.log('[路径] 程序目录不可写(' + paths.error + '), 数据改存: ' + DATA_DIR);
  console.log('[路径] 建议把整个 WinMon 目录移出 Program Files 或磁盘根目录, 例如 D:\\WinMon');
}
const cfg = loadConfig();
let dbFile = path.join(DATA_DIR, 'monitor.db');
const legacyDb = path.join(ROOT, 'data', 'monitor.db');
if (paths.redirected && fs.existsSync(legacyDb) && !fs.existsSync(dbFile)) {
  // 数据目录已迁移到用户目录, 把旧库一并搬过去再走正常迁移流程。
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.writeFileSync(dbFile + suffix, fs.readFileSync(legacyDb + suffix)); } catch (e) {}
  }
  console.log('[路径] 已将旧版 monitor.db 复制到新数据目录以便迁移');
}
const db = new DB(dbFile);
db.seedTriggers();
db.seedProbeTriggers();
paths.writeQuiet(paths.PID_FILE, String(process.pid));

const startedAt = Date.now();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function orNull(v) { return v == null ? null : v; }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function ingest(info, m, ts) {
  const hostId = db.upsertHost(info, ts);
  db.insertHistory(hostId, m, ts);
  const host = db.getHost(hostId);
  alert.evaluate(db, host, m, ts, cfg);
  return hostId;
}

function hostOnline(h, now) {
  const timeout = Math.max(90000, cfg.collection.interval_sec * 4000);
  return now - h.last_seen <= timeout;
}

function handlePush(req, res, body) {
  if (cfg.token && body.token !== cfg.token) return json(res, 403, { error: 'token 无效' });
  const key = String(body.key || '').trim().slice(0, 128);
  if (!key) return json(res, 400, { error: '缺少主机标识 key' });
  if (!body.metrics || typeof body.metrics !== 'object') return json(res, 400, { error: '缺少 metrics' });
  const m = {};
  let n = 0;
  for (const [k, v] of Object.entries(body.metrics)) {
    if (typeof v === 'number' && isFinite(v) && k.length <= 128 && ++n <= 200) m[k] = v;
  }
  const info = {
    key,
    name: String(body.name || key).slice(0, 128),
    ip: String(body.ip || req.socket.remoteAddress || '').slice(0, 64),
    os: String(body.os || '').slice(0, 128),
    cpu: String(body.cpu || '').slice(0, 128),
  };
  const id = ingest(info, m, Date.now());
  json(res, 200, { ok: true, host_id: id });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && p === '/api/push') {
        return handlePush(req, res, await readBody(req));
      }
      if (req.method === 'GET' && p === '/api/health') {
        return json(res, 200, {
          ok: true, version: VERSION, uptime: Math.floor((Date.now() - startedAt) / 1000),
          node: process.version,
          lan_url: 'http://' + metrics.localIp() + ':' + cfg.server.port,
        });
      }
      if (req.method === 'POST' && p === '/api/shutdown') {
        const ra = req.socket.remoteAddress || '';
        if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') {
          return json(res, 403, { error: '仅允许本机回环地址关闭服务' });
        }
        json(res, 200, { ok: true });
        setTimeout(shutdown, 300);
        return;
      }
      if (req.method === 'POST' && p === '/api/restart') {
        const ra = req.socket.remoteAddress || '';
        if (ra !== '127.0.0.1' && ra !== '::1' && ra !== '::ffff:127.0.0.1') {
          return json(res, 403, { error: '仅允许本机回环地址重启服务' });
        }
        json(res, 200, { ok: true });
        setTimeout(restart, 300);
        return;
      }
      if (req.method === 'GET' && p === '/api/notify') {
        const m = cfg.mail || {};
        return json(res, 200, {
          webhook_url: cfg.webhook_url || '',
          mail: {
            enabled: !!m.enabled, host: m.host || '', port: m.port || 465,
            secure: m.secure || 'ssl', user: m.user || '', from: m.from || '', to: m.to || '',
            has_pass: !!m.pass,
          },
        });
      }
      if (req.method === 'POST' && p === '/api/notify') {
        const b = await readBody(req);
        cfg.webhook_url = String(b.webhook_url || '').trim().slice(0, 500);
        const m = b.mail || {};
        const secure = ['ssl', 'starttls', 'none'].includes(m.secure) ? m.secure : 'ssl';
        const defPort = secure === 'ssl' ? 465 : secure === 'starttls' ? 587 : 25;
        const port = Math.max(1, Math.min(65535, Math.floor(Number(m.port) || defPort)));
        const pass = String(m.pass || '');
        cfg.mail = {
          enabled: !!m.enabled,
          host: String(m.host || '').trim().slice(0, 255),
          port, secure,
          user: String(m.user || '').trim().slice(0, 255),
          pass: pass ? pass.slice(0, 255) : (cfg.mail.pass || ''),
          from: String(m.from || '').trim().slice(0, 255),
          to: String(m.to || '').trim().slice(0, 500),
        };
        saveConfig();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/mail/test') {
        if (!cfg.mail || !cfg.mail.host) return json(res, 400, { error: '请先填写并保存 SMTP 服务器地址' });
        if (!cfg.mail.to) return json(res, 400, { error: '请先填写收件人邮箱' });
        try {
          await mailer.sendMail({ ...cfg.mail, enabled: true }, {
            subject: '[WinMon] 测试邮件',
            text: `这是一封来自 WinMon 监控系统的测试邮件。\n\n如果你收到此邮件, 说明 SMTP 邮件通知配置成功。\n\n发送时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n— WinMon 监控系统`,
          });
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { error: '邮件发送失败: ' + e.message });
        }
      }
      if (req.method === 'GET' && p === '/api/hosts') {
        const now = Date.now();
        const hosts = db.getHosts().map(h => {
          const latest = {};
          for (const r of db.getLatest(h.id)) latest[r.item] = r.value;
          let diskMax = 0;
          for (const [k, v] of Object.entries(latest)) {
            if (k.startsWith('disk.used_pct') && v > diskMax) diskMax = v;
          }
          return {
            ...h, online: hostOnline(h, now), alerts: db.activeAlertCount(h.id),
            cpu_util: orNull(latest['cpu.util']), mem_pct: orNull(latest['mem.used_pct']),
            disk_max: diskMax, net_in: orNull(latest['net.in']), net_out: orNull(latest['net.out']),
            uptime: orNull(latest['sys.uptime']),
            ping_latency: orNull(latest['ping.latency']), ping_loss: orNull(latest['ping.loss']),
            ping_ok: orNull(latest['ping.ok']), tcp_open: orNull(latest['tcp.open']),
            http_ok: orNull(latest['http.ok']), db_ok: orNull(latest['db.ok']),
            snmp_up: orNull(latest['snmp.up']), snmp_in: orNull(latest['snmp.in']), snmp_out: orNull(latest['snmp.out']),
          };
        });
        return json(res, 200, hosts);
      }
      if (req.method === 'GET' && p === '/api/host') {
        const id = Number(u.searchParams.get('id'));
        const h = db.getHost(id);
        if (!h) return json(res, 404, { error: '主机不存在' });
        const latest = db.getLatest(id).map(r => ({ ...r, meta: metrics.itemMeta(r.item) }));
        return json(res, 200, { ...h, online: hostOnline(h, Date.now()), latest, items: db.getItems(id), alerts: db.activeAlertCount(id) });
      }
      if (req.method === 'GET' && p === '/api/history') {
        const id = Number(u.searchParams.get('host_id'));
        const item = u.searchParams.get('item') || '';
        const range = Math.min(30 * 86400, Math.max(60, Number(u.searchParams.get('range')) || 3600));
        const now = Date.now();
        const points = db.getHistory(id, item, now - range * 1000, now);
        return json(res, 200, { item, meta: metrics.itemMeta(item), points });
      }
      if (req.method === 'GET' && p === '/api/alerts') {
        const status = u.searchParams.get('status') === 'all' ? 'all' : 'active';
        return json(res, 200, db.getAlerts(status));
      }
      if (req.method === 'GET' && p === '/api/triggers') {
        return json(res, 200, db.getTriggers());
      }
      if (req.method === 'POST' && p === '/api/triggers') {
        const b = await readBody(req);
        const t = sanitizeTrigger(b);
        if (t.error) return json(res, 400, t);
        return json(res, 200, { ok: true, id: db.addTrigger(t) });
      }
      if (req.method === 'PUT' && p === '/api/triggers') {
        const id = Number(u.searchParams.get('id'));
        if (!db.getTrigger(id)) return json(res, 404, { error: '触发器不存在' });
        const t = sanitizeTrigger(await readBody(req));
        if (t.error) return json(res, 400, t);
        db.updateTrigger(id, t);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && p === '/api/triggers') {
        db.deleteTrigger(Number(u.searchParams.get('id')));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && p === '/api/host') {
        const id = Number(u.searchParams.get('id'));
        if (!db.getHost(id)) return json(res, 404, { error: '主机不存在' });
        const b = await readBody(req);
        const name = String(b.name || '').trim().slice(0, 128);
        if (!name) return json(res, 400, { error: '名称不能为空' });
        db.renameHost(id, name);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && p === '/api/host') {
        db.deleteHost(Number(u.searchParams.get('id')));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/targets') {
        return json(res, 200, db.getTargets());
      }
      if (req.method === 'POST' && p === '/api/targets') {
        const t = sanitizeTarget(await readBody(req));
        if (t.error) return json(res, 400, t);
        const id = db.addTarget(t);
        db.setChecks(id, t.checks);
        probeNext.delete(id);
        return json(res, 200, { ok: true, id });
      }
      if (req.method === 'PUT' && p === '/api/targets') {
        const id = Number(u.searchParams.get('id'));
        if (!db.getTarget(id)) return json(res, 404, { error: '目标不存在' });
        const t = sanitizeTarget(await readBody(req));
        if (t.error) return json(res, 400, t);
        db.updateTarget(id, t);
        db.setChecks(id, t.checks);
        probeNext.delete(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && p === '/api/targets') {
        const id = Number(u.searchParams.get('id'));
        db.deleteTarget(id);
        probeNext.delete(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/targets/test') {
        const id = Number(u.searchParams.get('id'));
        const t = db.getTarget(id);
        if (!t) return json(res, 404, { error: '目标不存在' });
        const checks = db.getTargets().find(x => x.id === id).checks.filter(c => c.enabled);
        const r = await probe.runTarget(t, checks);
        return json(res, 200, r);
      }
      if (req.method === 'GET' && p === '/api/catalog') {
        return json(res, 200, { items: metrics.ITEM_META, severities: alert.SEVERITY_NAME, ops: ['>', '>=', '<', '<=', '=', '!='] });
      }
      if (req.method === 'GET' && p === '/api/stats') {
        return json(res, 200, {
          version: VERSION, uptime: Math.floor((Date.now() - startedAt) / 1000),
          hosts: db.getHosts().length, points: db.countHistory(),
          active_alerts: db.getAlerts('active').length,
          retention_days: cfg.retention_days, interval_sec: cfg.collection.interval_sec,
          port: cfg.server.port,
          agent_package: fs.existsSync(path.join(ROOT, 'agent-package.zip')),
        });
      }
      return json(res, 404, { error: '接口不存在' });
    }

    if (req.method === 'GET' && p === '/download/agent-package.zip') {
      const file = path.join(ROOT, 'agent-package.zip');
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('agent-package.zip 不存在, 请先在服务端目录运行 make-agent.bat 生成');
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': 'attachment; filename="agent-package.zip"',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    let rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[请求错误]', p, e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

function sanitizeTrigger(b) {
  const name = String(b.name || '').trim().slice(0, 128);
  const item = String(b.item || '').trim().slice(0, 128);
  const op = String(b.op || '>');
  const threshold = Number(b.threshold);
  const duration = Math.max(1, Math.min(100, Math.floor(Number(b.duration) || 1)));
  const severity = ['info', 'warning', 'critical'].includes(b.severity) ? b.severity : 'warning';
  const host_id = b.host_id == null || b.host_id === '' ? null : Number(b.host_id);
  if (!name || !item) return { error: '名称和指标不能为空' };
  if (!['>', '>=', '<', '<=', '=', '!='].includes(op)) return { error: '无效的比较符' };
  if (!isFinite(threshold)) return { error: '阈值必须是数字' };
  return { name, item, op, threshold, duration, severity, host_id, enabled: b.enabled !== false && b.enabled !== 0 };
}

const DEVICE_TYPES = ['camera', 'switch', 'firewall', 'controller', 'linux', 'windows', 'db', 'network', 'app', 'other'];
const CHECK_KINDS = ['ping', 'tcp', 'http', 'snmp', 'db'];

function sanitizeTarget(b) {
  const name = String(b.name || '').trim().slice(0, 128);
  const address = String(b.address || '').trim().slice(0, 255);
  const type = DEVICE_TYPES.includes(b.type) ? b.type : 'other';
  const interval_sec = Math.max(10, Math.min(3600, Math.floor(Number(b.interval_sec) || 60)));
  if (!name || !address) return { error: '名称和地址不能为空' };
  const checks = Array.isArray(b.checks) ? b.checks.filter(c => CHECK_KINDS.includes(c.kind)).map(c => ({ kind: c.kind, params: typeof c.params === 'object' && c.params ? c.params : {} })) : [];
  if (!checks.length) return { error: '至少选择一种探测方式' };
  return { name, address, type, interval_sec, enabled: b.enabled !== false && b.enabled !== 0, note: String(b.note || '').slice(0, 255), checks };
}

let localRunning = false;
async function localTick() {
  if (localRunning) return;
  localRunning = true;
  try {
    const info = metrics.hostInfo();
    if (cfg.server.local_name) info.name = cfg.server.local_name;
    const m = await metrics.collect(cfg.collection.slow_interval_sec * 1000);
    ingest(info, m, Date.now());
  } catch (e) {
    console.error('[本地采集失败]', e.message);
  } finally {
    localRunning = false;
  }
}

function offlineTick() {
  try {
    const timeout = Math.max(90000, cfg.collection.interval_sec * 4000);
    alert.checkOffline(db, db.getHosts(), Date.now(), timeout, cfg);
  } catch (e) { console.error('[离线检查失败]', e.message); }
}

function cleanupTick() {
  try {
    const before = Date.now() - cfg.retention_days * 86400000;
    const n = db.cleanupHistory(before);
    db.cleanupAlerts(Date.now() - 30 * 86400000);
    if (n > 0) console.log(`[清理] 删除过期历史数据 ${n} 条`);
  } catch (e) { console.error('[清理失败]', e.message); }
}

const probeNext = new Map();
const probeRunning = new Set();
function probeTick() {
  const now = Date.now();
  let targets;
  try { targets = db.getTargets(); } catch { return; }
  for (const t of targets) {
    if (!t.enabled || probeRunning.has(t.id)) continue;
    if (now < (probeNext.get(t.id) || 0)) continue;
    probeNext.set(t.id, now + t.interval_sec * 1000);
    probeRunning.add(t.id);
    (async () => {
      try {
        const checks = t.checks.filter(c => c.enabled);
        if (!checks.length) return;
        const r = await probe.runTarget(t, checks);
        if (!db.getTarget(t.id)) return; // 探测期间目标已被删除, 不再重建主机/告警
        const ts = Date.now();
        const hostId = db.upsertProbeHost(t, ts);
        if (Object.keys(r.metrics).length) {
          db.insertHistory(hostId, r.metrics, ts);
          alert.evaluate(db, db.getHost(hostId), r.metrics, ts, cfg);
        }
        db.setTargetError(t.id, r.error);
      } catch (e) { console.error('[探测失败]', t.name, e.message); }
      finally { probeRunning.delete(t.id); }
    })();
  }
}

const isRestartChild = process.env.WINMON_RESTART_CHILD === '1';
let listenAttempts = 0;
function startListen() {
  server.listen(cfg.server.port, cfg.server.host, () => {
    console.log('======================================================');
    console.log(`  WinMon 监控系统 v${VERSION} 已启动`);
    console.log(`  Web 管理界面: http://127.0.0.1:${cfg.server.port}`);
    console.log(`  本机采集间隔: ${cfg.collection.interval_sec} 秒, 数据保留: ${cfg.retention_days} 天`);
    console.log(`  Agent 上报地址: http://<本机IP>:${cfg.server.port}/api/push`);
    console.log('  按 Ctrl+C 停止服务');
    console.log('======================================================');
    if (!isRestartChild && process.platform === 'win32' && cfg.server.open_browser !== false) {
      require('child_process').exec(`start "" "http://127.0.0.1:${cfg.server.port}"`);
    }
    setTimeout(localTick, 1500);
    setInterval(localTick, cfg.collection.interval_sec * 1000);
    setInterval(offlineTick, 15000);
    setInterval(cleanupTick, 3600000);
    setTimeout(cleanupTick, 5000);
    setInterval(probeTick, 1000);
    setTimeout(probeTick, 2000);
  });
}

if (isRestartChild) {
  console.log('[重启] 新进程已拉起, 等待旧进程释放端口...');
  setTimeout(startListen, 1200);
} else {
  startListen();
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    if (isRestartChild && listenAttempts < 10) {
      listenAttempts++;
      console.error(`[重启] 端口仍被占用, 重试 ${listenAttempts}/10...`);
      setTimeout(startListen, 1000);
      return;
    }
    console.error(`端口 ${cfg.server.port} 已被占用, 请修改 config.json 中的 server.port 后重试`);
  } else {
    console.error('服务启动失败:', e.message);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n正在停止服务...');
  try { db.close(); } catch {}
  try { fs.unlinkSync(path.join(DATA_DIR, 'server.pid')); } catch {}
  process.exit(0);
}

function restart() {
  console.log('\n正在重启服务...');
  try {
    // 新进程会自己把日志写入 server.log, 这里不再传日志句柄,
    // 避免与父进程持有的追加句柄相互独占。
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WINMON_RESTART_CHILD: '1' },
    });
    child.unref();
    console.log(`[重启] 已拉起新进程 PID=${child.pid}, 旧进程即将退出`);
  } catch (e) {
    console.error('[重启] 拉起新进程失败, 保持当前进程运行:', e.message);
    return;
  }
  if (logFd != null) { try { fs.closeSync(logFd); } catch {} }
  // 不删除 server.pid: 新进程启动时会写入自己的 PID, 避免竞态导致 pid 文件丢失
  setTimeout(() => {
    try { server.close(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  }, 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);