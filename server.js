'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const DB = require('./lib/db');
const metrics = require('./lib/metrics');
const alert = require('./lib/alert');
const probe = require('./lib/probe');

const ROOT = __dirname;
const VERSION = '1.1.0';
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULT_CONFIG = {
  server: { host: '0.0.0.0', port: 8686, local_name: '', open_browser: true },
  agent: { server_url: 'http://127.0.0.1:8686', token: '', interval_sec: 15, hostname: '', name: '' },
  collection: { interval_sec: 15, slow_interval_sec: 30 },
  retention_days: 7,
  token: '',
  webhook_url: '',
};

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('config.json 解析失败, 使用默认配置:', e.message); }
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
  return {
    server: { ...DEFAULT_CONFIG.server, ...cfg.server },
    agent: { ...DEFAULT_CONFIG.agent, ...cfg.agent },
    collection: { ...DEFAULT_CONFIG.collection, ...cfg.collection },
    retention_days: cfg.retention_days ?? DEFAULT_CONFIG.retention_days,
    token: cfg.token ?? '',
    webhook_url: cfg.webhook_url ?? '',
  };
}

const cfg = loadConfig();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DB(path.join(DATA_DIR, 'monitor.db'));
db.seedTriggers();
db.seedProbeTriggers();
fs.writeFileSync(path.join(DATA_DIR, 'server.pid'), String(process.pid), 'utf8');

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
  alert.evaluate(db, host, m, ts, cfg.webhook_url);
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
        return json(res, 200, { ok: true, version: VERSION, uptime: Math.floor((Date.now() - startedAt) / 1000) });
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
            cpu_util: latest['cpu.util'] ?? null, mem_pct: latest['mem.used_pct'] ?? null,
            disk_max: diskMax, net_in: latest['net.in'] ?? null, net_out: latest['net.out'] ?? null,
            uptime: latest['sys.uptime'] ?? null,
            ping_latency: latest['ping.latency'] ?? null, ping_loss: latest['ping.loss'] ?? null,
            ping_ok: latest['ping.ok'] ?? null, tcp_open: latest['tcp.open'] ?? null,
            http_ok: latest['http.ok'] ?? null, db_ok: latest['db.ok'] ?? null,
            snmp_up: latest['snmp.up'] ?? null, snmp_in: latest['snmp.in'] ?? null, snmp_out: latest['snmp.out'] ?? null,
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
        db.deleteTarget(Number(u.searchParams.get('id')));
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
    alert.checkOffline(db, db.getHosts(), Date.now(), timeout, cfg.webhook_url);
  } catch (e) { console.error('[离线检查失败]', e.message); }
}

function cleanupTick() {
  try {
    const before = Date.now() - cfg.retention_days * 86400000;
    const n = db.cleanupHistory(before);
    db.db.prepare("DELETE FROM alerts WHERE status='resolved' AND end_ts < ?").run(Date.now() - 30 * 86400000);
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
        const ts = Date.now();
        const hostId = db.upsertProbeHost(t, ts);
        if (Object.keys(r.metrics).length) {
          db.insertHistory(hostId, r.metrics, ts);
          alert.evaluate(db, db.getHost(hostId), r.metrics, ts, cfg.webhook_url);
        }
        db.setTargetError(t.id, r.error);
      } catch (e) { console.error('[探测失败]', t.name, e.message); }
      finally { probeRunning.delete(t.id); }
    })();
  }
}

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log('======================================================');
  console.log(`  WinMon 监控系统 v${VERSION} 已启动`);
  console.log(`  Web 管理界面: http://127.0.0.1:${cfg.server.port}`);
  console.log(`  本机采集间隔: ${cfg.collection.interval_sec} 秒, 数据保留: ${cfg.retention_days} 天`);
  console.log(`  Agent 上报地址: http://<本机IP>:${cfg.server.port}/api/push`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('======================================================');
  if (process.platform === 'win32' && cfg.server.open_browser !== false) {
    require('node:child_process').exec(`start "" "http://127.0.0.1:${cfg.server.port}"`);
  }
  setTimeout(localTick, 1500);
  setInterval(localTick, cfg.collection.interval_sec * 1000);
  setInterval(offlineTick, 15000);
  setInterval(cleanupTick, 3600000);
  setTimeout(cleanupTick, 5000);
  setInterval(probeTick, 1000);
  setTimeout(probeTick, 2000);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
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
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);