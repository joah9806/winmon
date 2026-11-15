'use strict';
const { DatabaseSync } = require('node:sqlite');

class DB {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        ip TEXT DEFAULT '',
        os TEXT DEFAULT '',
        cpu TEXT DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL,
        item TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history ON history(host_id, item, ts);
      CREATE TABLE IF NOT EXISTS triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        item TEXT NOT NULL,
        op TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration INTEGER NOT NULL DEFAULT 1,
        severity TEXT NOT NULL DEFAULT 'warning',
        host_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id INTEGER NOT NULL DEFAULT 0,
        host_id INTEGER NOT NULL,
        item TEXT NOT NULL DEFAULT '',
        start_ts INTEGER NOT NULL,
        end_ts INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        value REAL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts ON alerts(status, start_ts);
      CREATE TABLE IF NOT EXISTS targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        address TEXT NOT NULL,
        interval_sec INTEGER NOT NULL DEFAULT 60,
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT DEFAULT '',
        last_error TEXT DEFAULT '',
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_checks ON checks(target_id);
    `);
    this._migrateHosts();
  }

  _migrateHosts() {
    const cols = this.db.prepare('PRAGMA table_info(hosts)').all().map(c => c.name);
    if (!cols.includes('kind')) this.db.exec("ALTER TABLE hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    if (!cols.includes('dtype')) this.db.exec("ALTER TABLE hosts ADD COLUMN dtype TEXT DEFAULT ''");
  }

  close() { this.db.close(); }

  upsertHost(info, ts) {
    const exist = this.db.prepare('SELECT id, name FROM hosts WHERE host_key = ?').get(info.key);
    if (exist) {
      this.db.prepare('UPDATE hosts SET last_seen = ?, ip = ?, os = ?, cpu = ? WHERE id = ?')
        .run(ts, info.ip || '', info.os || '', info.cpu || '', exist.id);
      return exist.id;
    }
    const r = this.db.prepare('INSERT INTO hosts(host_key, name, ip, os, cpu, first_seen, last_seen) VALUES(?,?,?,?,?,?,?)')
      .run(info.key, info.name || info.key, info.ip || '', info.os || '', info.cpu || '', ts, ts);
    return Number(r.lastInsertRowid);
  }

  getHosts() { return this.db.prepare('SELECT * FROM hosts ORDER BY id').all(); }
  getHost(id) { return this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id); }
  renameHost(id, name) { this.db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, id); }
  deleteHost(id) {
    const h = this.getHost(id);
    this.db.prepare('DELETE FROM history WHERE host_id = ?').run(id);
    this.db.prepare('DELETE FROM alerts WHERE host_id = ?').run(id);
    this.db.prepare('UPDATE triggers SET host_id = NULL WHERE host_id = ?').run(id);
    this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    if (h && h.host_key.startsWith('probe:')) {
      const tid = Number(h.host_key.slice(6));
      this.db.prepare('DELETE FROM checks WHERE target_id = ?').run(tid);
      this.db.prepare('DELETE FROM targets WHERE id = ?').run(tid);
    }
  }

  // ---- 探测目标 ----
  getTargets() {
    const ts = this.db.prepare('SELECT * FROM targets ORDER BY id').all();
    const cs = this.db.prepare('SELECT * FROM checks ORDER BY id').all();
    for (const t of ts) {
      t.checks = cs.filter(c => c.target_id === t.id).map(c => ({ ...c, params: JSON.parse(c.params || '{}') }));
    }
    return ts;
  }
  getTarget(id) { return this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id); }
  addTarget(t) {
    const r = this.db.prepare('INSERT INTO targets(name, type, address, interval_sec, enabled, note, created) VALUES(?,?,?,?,?,?,?)')
      .run(t.name, t.type, t.address, t.interval_sec, t.enabled ? 1 : 0, t.note || '', Date.now());
    return Number(r.lastInsertRowid);
  }
  updateTarget(id, t) {
    this.db.prepare('UPDATE targets SET name=?, type=?, address=?, interval_sec=?, enabled=?, note=? WHERE id=?')
      .run(t.name, t.type, t.address, t.interval_sec, t.enabled ? 1 : 0, t.note || '', id);
  }
  setTargetError(id, err) { this.db.prepare('UPDATE targets SET last_error=? WHERE id=?').run(err || '', id); }
  deleteTarget(id) {
    this.db.prepare('DELETE FROM checks WHERE target_id = ?').run(id);
    this.db.prepare('DELETE FROM targets WHERE id = ?').run(id);
    const h = this.db.prepare('SELECT id FROM hosts WHERE host_key = ?').get('probe:' + id);
    if (h) this.deleteHost(h.id);
  }
  setChecks(targetId, checks) {
    this.db.prepare('DELETE FROM checks WHERE target_id = ?').run(targetId);
    const ins = this.db.prepare('INSERT INTO checks(target_id, kind, params, enabled) VALUES(?,?,?,1)');
    for (const c of checks) ins.run(targetId, c.kind, JSON.stringify(c.params || {}));
  }
  upsertProbeHost(t, ts) {
    const key = 'probe:' + t.id;
    const exist = this.db.prepare('SELECT id FROM hosts WHERE host_key = ?').get(key);
    if (exist) {
      this.db.prepare("UPDATE hosts SET name=?, ip=?, dtype=?, kind='probe', last_seen=? WHERE id=?")
        .run(t.name, t.address, t.type, ts, exist.id);
      return exist.id;
    }
    const r = this.db.prepare("INSERT INTO hosts(host_key, name, ip, os, cpu, first_seen, last_seen, kind, dtype) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(key, t.name, t.address, '', '', ts, ts, 'probe', t.type);
    return Number(r.lastInsertRowid);
  }
  seedProbeTriggers() {
    const has = n => this.db.prepare('SELECT id FROM triggers WHERE name = ?').get(n);
    const ins = this.db.prepare('INSERT INTO triggers(name, item, op, threshold, duration, severity, host_id, enabled) VALUES(?,?,?,?,?,?,?,1)');
    const defs = [
      ['探测丢包过高', 'ping.loss', '>', 50, 2, 'critical'],
      ['探测时延过高', 'ping.latency', '>', 200, 3, 'warning'],
      ['端口不通', 'tcp.open', '=', 0, 2, 'critical'],
      ['数据库连接失败', 'db.ok', '=', 0, 1, 'critical'],
      ['HTTP服务异常', 'http.ok', '=', 0, 2, 'warning'],
      ['SNMP不可达', 'snmp.up', '=', 0, 2, 'warning'],
    ];
    for (const [n, item, op, th, du, sv] of defs) if (!has(n)) ins.run(n, item, op, th, du, sv, null);
  }

  insertHistory(hostId, metrics, ts) {
    const stmt = this.db.prepare('INSERT INTO history(host_id, item, ts, value) VALUES(?,?,?,?)');
    this.db.exec('BEGIN');
    try {
      for (const [item, value] of Object.entries(metrics)) {
        if (typeof value === 'number' && isFinite(value)) stmt.run(hostId, item, ts, value);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getLatest(hostId) {
    return this.db.prepare(`
      SELECT h.item, h.value, h.ts FROM history h
      JOIN (SELECT item, MAX(id) AS mid FROM history WHERE host_id = ? GROUP BY item) x ON h.id = x.mid
    `).all(hostId);
  }

  getItems(hostId) {
    return this.db.prepare('SELECT DISTINCT item FROM history WHERE host_id = ? ORDER BY item').all(hostId).map(r => r.item);
  }

  getHistory(hostId, item, fromTs, toTs, maxPoints = 600) {
    const rows = this.db.prepare(
      'SELECT ts, value FROM history WHERE host_id = ? AND item = ? AND ts >= ? AND ts <= ? ORDER BY ts'
    ).all(hostId, item, fromTs, toTs);
    if (rows.length <= maxPoints) return rows;
    const bucket = Math.ceil(rows.length / maxPoints);
    const out = [];
    for (let i = 0; i < rows.length; i += bucket) {
      const slice = rows.slice(i, i + bucket);
      let sum = 0;
      for (const r of slice) sum += r.value;
      out.push({ ts: slice[Math.floor(slice.length / 2)].ts, value: sum / slice.length });
    }
    return out;
  }

  lastValues(hostId, item, n) {
    return this.db.prepare(
      'SELECT value FROM history WHERE host_id = ? AND item = ? ORDER BY ts DESC, id DESC LIMIT ?'
    ).all(hostId, item, n).map(r => r.value);
  }

  cleanupHistory(beforeTs) {
    const r = this.db.prepare('DELETE FROM history WHERE ts < ?').run(beforeTs);
    return Number(r.changes);
  }

  countHistory() { return this.db.prepare('SELECT COUNT(*) AS c FROM history').get().c; }

  seedTriggers() {
    const c = this.db.prepare('SELECT COUNT(*) AS c FROM triggers').get().c;
    if (c > 0) return;
    const ins = this.db.prepare('INSERT INTO triggers(name, item, op, threshold, duration, severity, host_id, enabled) VALUES(?,?,?,?,?,?,?,1)');
    ins.run('CPU使用率过高', 'cpu.util', '>', 90, 3, 'critical', null);
    ins.run('内存使用率过高', 'mem.used_pct', '>', 90, 3, 'warning', null);
    ins.run('磁盘空间不足', 'disk.used_pct*', '>', 90, 1, 'warning', null);
  }

  getTriggers() {
    return this.db.prepare(`
      SELECT t.*, h.name AS host_name FROM triggers t LEFT JOIN hosts h ON t.host_id = h.id ORDER BY t.id
    `).all();
  }
  getTrigger(id) { return this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id); }
  addTrigger(t) {
    const r = this.db.prepare('INSERT INTO triggers(name, item, op, threshold, duration, severity, host_id, enabled) VALUES(?,?,?,?,?,?,?,?)')
      .run(t.name, t.item, t.op, t.threshold, t.duration, t.severity, t.host_id ?? null, t.enabled ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  updateTrigger(id, t) {
    this.db.prepare('UPDATE triggers SET name=?, item=?, op=?, threshold=?, duration=?, severity=?, host_id=?, enabled=? WHERE id=?')
      .run(t.name, t.item, t.op, t.threshold, t.duration, t.severity, t.host_id ?? null, t.enabled ? 1 : 0, id);
  }
  deleteTrigger(id) {
    this.db.prepare('DELETE FROM alerts WHERE trigger_id = ?').run(id);
    this.db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  }

  getActiveAlert(triggerId, hostId, item) {
    return this.db.prepare("SELECT * FROM alerts WHERE trigger_id=? AND host_id=? AND item=? AND status='active'")
      .get(triggerId, hostId, item);
  }
  fireAlert(a) {
    const r = this.db.prepare('INSERT INTO alerts(trigger_id, host_id, item, start_ts, status, value, message) VALUES(?,?,?,?,?,?,?)')
      .run(a.trigger_id, a.host_id, a.item, a.ts, 'active', a.value, a.message);
    return Number(r.lastInsertRowid);
  }
  resolveAlert(id, ts, value) {
    this.db.prepare("UPDATE alerts SET status='resolved', end_ts=?, value=? WHERE id=?").run(ts, value, id);
  }
  getAlerts(status, limit = 200) {
    const where = status === 'active' ? "WHERE a.status='active'" : '';
    return this.db.prepare(`
      SELECT a.*, h.name AS host_name, t.name AS trigger_name, t.severity
      FROM alerts a LEFT JOIN hosts h ON a.host_id=h.id LEFT JOIN triggers t ON a.trigger_id=t.id
      ${where} ORDER BY a.start_ts DESC LIMIT ?
    `).all(limit);
  }
  activeAlertCount(hostId) {
    return this.db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE status='active' AND host_id=?").get(hostId).c;
  }
  resolveOfflineAlert(hostId, ts) {
    const a = this.db.prepare("SELECT * FROM alerts WHERE trigger_id=0 AND host_id=? AND status='active'").get(hostId);
    if (a) this.resolveAlert(a.id, ts, null);
    return a;
  }
  getOfflineAlert(hostId) {
    return this.db.prepare("SELECT * FROM alerts WHERE trigger_id=0 AND host_id=? AND status='active'").get(hostId);
  }
}

module.exports = DB;