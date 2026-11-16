'use strict';
// 零依赖数据访问层, 兼容 Node 12 (Windows 7)。
// 替代原先的 node:sqlite (仅 Node 22+ 提供), 对外保持相同的方法与行结构。
const fs = require('fs');
const path = require('path');
const { MetaStore, Series, mkdirp } = require('./store');

function copy(o) { return Object.assign({}, o); }
function num(v, d) { return v == null ? d : Number(v); }
function byId(a, b) { return a.id - b.id; }
function dtypeFromOs(os) {
  const s = String(os || '');
  if (/windows/i.test(s)) return 'windows';
  if (/linux/i.test(s)) return 'linux';
  return '';
}

class DB {
  constructor(file) {
    const dir = path.dirname(file);
    mkdirp(dir);
    this.dir = dir;
    this.storeFile = path.join(dir, 'store.json');
    this.meta = new MetaStore(this.storeFile);
    this.series = new Series(path.join(dir, 'history'));
    this.migration = null;
    if (!this.meta.loaded && fs.existsSync(file)) this._importLegacy(file);
    this._normalizeHosts();
  }

  // 旧库没有 name_custom / dtype 字段。名字与主机标识不同的视为用户已自定义,
  // 否则升级后第一次上报就会把改好的名字覆盖回机器名。
  _normalizeHosts() {
    let changed = false;
    for (const h of this.meta.tables.hosts) {
      if (h.name_custom == null) {
        h.name_custom = h.kind === 'agent' && h.name !== h.host_key ? 1 : 0;
        changed = true;
      }
      if (h.kind === 'agent' && !h.dtype) {
        const d = dtypeFromOs(h.os);
        if (d) { h.dtype = d; changed = true; }
      }
      if (h.alert_muted == null) { h.alert_muted = 0; changed = true; }
    }
    if (changed) this.meta.save();
  }

  _importLegacy(file) {
    let readSqlite;
    try { readSqlite = require('./sqlite-import').readSqlite; }
    catch (e) { console.error('[迁移] 无法加载解析器:', e.message); return; }
    console.log('[迁移] 检测到旧版 monitor.db, 正在转换为新的存储格式...');
    let data;
    try { data = readSqlite(file); }
    catch (e) {
      console.error('[迁移] 读取旧数据库失败, 将以空数据启动:', e.message);
      this.migration = { ok: false, error: e.message };
      return;
    }
    if (data.warning) console.log('[迁移] ' + data.warning);
    const T = this.meta.tables;
    const rowsOf = n => (data.tables[n] ? data.tables[n].rows : []);
    let points = 0;
    try {
      for (const h of rowsOf('hosts')) {
        T.hosts.push({
          id: num(h.id, h.rowid), host_key: String(h.host_key || ''), name: String(h.name || h.host_key || ''),
          ip: h.ip || '', os: h.os || '', cpu: h.cpu || '',
          first_seen: num(h.first_seen, 0), last_seen: num(h.last_seen, 0),
          kind: h.kind || 'agent', dtype: h.dtype || '',
        });
      }
      for (const t of rowsOf('targets')) {
        T.targets.push({
          id: num(t.id, t.rowid), name: String(t.name || ''), type: t.type || 'other', address: String(t.address || ''),
          interval_sec: num(t.interval_sec, 60), enabled: t.enabled ? 1 : 0, note: t.note || '',
          last_error: t.last_error || '', created: num(t.created, Date.now()),
        });
      }
      for (const c of rowsOf('checks')) {
        let params = {};
        try { params = JSON.parse(c.params || '{}'); } catch (e) {}
        T.checks.push({
          id: num(c.id, c.rowid), target_id: num(c.target_id, 0),
          kind: String(c.kind || ''), params, enabled: c.enabled ? 1 : 0,
        });
      }
      for (const t of rowsOf('triggers')) {
        T.triggers.push({
          id: num(t.id, t.rowid), name: String(t.name || ''), item: String(t.item || ''), op: t.op || '>',
          threshold: num(t.threshold, 0), duration: num(t.duration, 1), severity: t.severity || 'warning',
          host_id: t.host_id == null ? null : Number(t.host_id), enabled: t.enabled ? 1 : 0,
        });
      }
      for (const a of rowsOf('alerts')) {
        T.alerts.push({
          id: num(a.id, a.rowid), trigger_id: num(a.trigger_id, 0), host_id: num(a.host_id, 0), item: a.item || '',
          start_ts: num(a.start_ts, 0), end_ts: a.end_ts == null ? null : Number(a.end_ts),
          status: a.status || 'active', value: a.value == null ? null : Number(a.value), message: String(a.message || ''),
        });
      }
      for (const t of Object.keys(T)) {
        let max = 0;
        for (const r of T[t]) if (r.id > max) max = r.id;
        this.meta.seq[t] = max;
      }

      const groups = new Map();
      for (const h of rowsOf('history')) {
        const hid = num(h.host_id, 0);
        const item = String(h.item || '');
        if (!hid || !item) continue;
        if (!groups.has(hid)) groups.set(hid, new Map());
        const byItem = groups.get(hid);
        if (!byItem.has(item)) byItem.set(item, []);
        byItem.get(item).push({ ts: num(h.ts, 0), value: Number(h.value) });
      }
      for (const [hid, byItem] of groups) {
        for (const [item, rows] of byItem) points += this.series.importSeries(hid, item, rows);
      }

      this.meta.save();
      const counts = {
        hosts: T.hosts.length, targets: T.targets.length, checks: T.checks.length,
        triggers: T.triggers.length, alerts: T.alerts.length, points,
      };
      console.log('[迁移] 完成: 主机 ' + counts.hosts + ', 设备 ' + counts.targets + ', 触发器 ' + counts.triggers +
        ', 告警 ' + counts.alerts + ', 历史点 ' + counts.points);
      // 归档旧库, 保留可回退的原始文件。
      for (const suffix of ['', '-wal', '-shm']) {
        const src = file + suffix;
        if (!fs.existsSync(src)) continue;
        try { fs.renameSync(src, src + '.migrated'); } catch (e) {
          console.error('[迁移] 归档失败 ' + path.basename(src) + ':', e.message);
        }
      }
      this.migration = { ok: true, counts };
    } catch (e) {
      console.error('[迁移] 转换失败, 将以已导入的部分数据启动:', e.message);
      this.migration = { ok: false, error: e.message };
      try { this.meta.save(); } catch (e2) {}
    }
  }

  close() {
    this.meta.close();
  }

  // ---- 主机 ----
  upsertHost(info, ts) {
    const T = this.meta.tables;
    const exist = T.hosts.find(h => h.host_key === info.key);
    if (exist) {
      exist.last_seen = ts;
      exist.ip = info.ip || '';
      exist.os = info.os || '';
      exist.cpu = info.cpu || '';
      // 界面上手工改过名字后以界面为准; 否则跟随上报名称, 让 config 里的 agent.name 生效。
      if (!exist.name_custom && info.name) exist.name = info.name;
      this.meta.touch();
      return exist.id;
    }
    const id = this.meta.nextId('hosts');
    T.hosts.push({
      id, host_key: info.key, name: info.name || info.key, ip: info.ip || '', os: info.os || '', cpu: info.cpu || '',
      first_seen: ts, last_seen: ts, kind: 'agent', dtype: dtypeFromOs(info.os), name_custom: 0, alert_muted: 0,
    });
    this.meta.save();
    return id;
  }

  getHosts() { return this.meta.tables.hosts.slice().sort(byId).map(copy); }
  getHost(id) { const h = this.meta.tables.hosts.find(x => x.id === id); return h ? copy(h) : undefined; }
  updateHost(id, patch) {
    const h = this.meta.tables.hosts.find(x => x.id === id);
    if (!h) return;
    if (patch.name != null) { h.name = patch.name; h.name_custom = 1; }
    if (patch.dtype != null) h.dtype = patch.dtype;
    this.meta.save();
  }

  // 忽略告警只影响告警, 采集与在线判断照常。忽略时关闭现有活动告警,
  // 否则它们会一直挂在概览和告警中心里, 而设备又不再产生新告警去覆盖。
  setHostMuted(id, muted, ts) {
    const h = this.meta.tables.hosts.find(x => x.id === id);
    if (!h) return null;
    h.alert_muted = muted ? 1 : 0;
    let resolved = 0;
    if (muted) {
      for (const a of this.meta.tables.alerts) {
        if (a.host_id !== id || a.status !== 'active') continue;
        a.status = 'resolved';
        a.end_ts = ts;
        resolved++;
      }
    }
    this.meta.save();
    return { muted: h.alert_muted, resolved };
  }
  deleteHost(id) {
    const T = this.meta.tables;
    const h = T.hosts.find(x => x.id === id);
    this.series.removeHost(id);
    T.alerts = T.alerts.filter(a => a.host_id !== id);
    for (const t of T.triggers) if (t.host_id === id) t.host_id = null;
    T.hosts = T.hosts.filter(x => x.id !== id);
    if (h && h.host_key.indexOf('probe:') === 0) {
      const tid = Number(h.host_key.slice(6));
      T.checks = T.checks.filter(c => c.target_id !== tid);
      T.targets = T.targets.filter(x => x.id !== tid);
    }
    this.meta.save();
  }

  // ---- 探测目标 ----
  getTargets() {
    const T = this.meta.tables;
    return T.targets.slice().sort(byId).map(t => {
      const out = copy(t);
      out.checks = T.checks.filter(c => c.target_id === t.id).sort(byId)
        .map(c => ({ id: c.id, target_id: c.target_id, kind: c.kind, params: copy(c.params || {}), enabled: c.enabled }));
      return out;
    });
  }
  getTarget(id) { const t = this.meta.tables.targets.find(x => x.id === id); return t ? copy(t) : undefined; }
  addTarget(t) {
    const id = this.meta.nextId('targets');
    this.meta.tables.targets.push({
      id, name: t.name, type: t.type, address: t.address, interval_sec: t.interval_sec,
      enabled: t.enabled ? 1 : 0, note: t.note || '', last_error: '', created: Date.now(),
    });
    this.meta.save();
    return id;
  }
  updateTarget(id, t) {
    const row = this.meta.tables.targets.find(x => x.id === id);
    if (!row) return;
    row.name = t.name; row.type = t.type; row.address = t.address;
    row.interval_sec = t.interval_sec; row.enabled = t.enabled ? 1 : 0; row.note = t.note || '';
    this.meta.save();
  }
  setTargetError(id, err) {
    const row = this.meta.tables.targets.find(x => x.id === id);
    if (row && row.last_error !== (err || '')) { row.last_error = err || ''; this.meta.touch(); }
  }
  deleteTarget(id) {
    const T = this.meta.tables;
    T.checks = T.checks.filter(c => c.target_id !== id);
    T.targets = T.targets.filter(x => x.id !== id);
    this.meta.save();
    const h = T.hosts.find(x => x.host_key === 'probe:' + id);
    if (h) this.deleteHost(h.id);
  }
  setChecks(targetId, checks) {
    const T = this.meta.tables;
    T.checks = T.checks.filter(c => c.target_id !== targetId);
    for (const c of checks) {
      T.checks.push({
        id: this.meta.nextId('checks'), target_id: targetId, kind: c.kind,
        params: copy(c.params || {}), enabled: 1,
      });
    }
    this.meta.save();
  }
  upsertProbeHost(t, ts) {
    const T = this.meta.tables;
    const key = 'probe:' + t.id;
    const exist = T.hosts.find(h => h.host_key === key);
    if (exist) {
      exist.name = t.name; exist.ip = t.address; exist.dtype = t.type; exist.kind = 'probe'; exist.last_seen = ts;
      this.meta.touch();
      return exist.id;
    }
    const id = this.meta.nextId('hosts');
    T.hosts.push({
      id, host_key: key, name: t.name, ip: t.address, os: '', cpu: '',
      first_seen: ts, last_seen: ts, kind: 'probe', dtype: t.type, name_custom: 0, alert_muted: 0,
    });
    this.meta.save();
    return id;
  }
  // 每种设备类型一个示例, 供导出 JSON/CSV 时参照填写。默认停用, 不会去探测这些
  // 示例 IP; 用 flags 记录只播种一次, 用户删掉后不会在下次启动时又冒出来。
  seedExampleTargets() {
    if (this.meta.flags.examples_seeded) return 0;
    const defs = [
      ['camera', '示例-摄像机', '192.168.1.10',
        [{ kind: 'ping' }, { kind: 'tcp', params: { port: 554 } }, { kind: 'http', params: { url: '' } }],
        '示例模板(默认停用): 摄像机一般开 RTSP 554 与 Web 80。改成真实 IP 后启用。'],
      ['switch', '示例-交换机', '192.168.1.2',
        [{ kind: 'ping' }, { kind: 'snmp', params: { community: 'public', version: '2c', ifIndex: 1, cpuOid: '' } }],
        '示例模板(默认停用): 交换机用 SNMP 取接口带宽, ifIndex 填要监控的接口号。'],
      ['firewall', '示例-防火墙', '192.168.1.1',
        [{ kind: 'ping' }, { kind: 'tcp', params: { port: 443 } }],
        '示例模板(默认停用): 防火墙看管理端口 443 是否存活。'],
      ['controller', '示例-设备控制器', '192.168.1.20',
        [{ kind: 'ping' }, { kind: 'tcp', params: { port: 502 } }],
        '示例模板(默认停用): 控制器/PLC 常用 Modbus TCP 502。'],
      ['linux', '示例-Linux服务器', '192.168.1.30',
        [{ kind: 'ping' }, { kind: 'tcp', params: { port: 22 } }],
        '示例模板(默认停用): 探测只能看端口存活, CPU/内存等深度指标请在该机器部署 Agent。'],
      ['windows', '示例-Windows电脑', '192.168.1.31',
        [{ kind: 'ping' }, { kind: 'tcp', params: { port: 3389 } }],
        '示例模板(默认停用): 3389 是远程桌面端口; 深度指标请部署 Agent。'],
      ['db', '示例-数据库服务器', '192.168.1.40',
        [{ kind: 'ping' }, { kind: 'db', params: { dbtype: 'mysql', port: 3306, user: 'monitor', password: '', db: '' } }],
        '示例模板(默认停用): 数据库用真实账号完成登录握手, 请填只读账号与密码。'],
      ['network', '示例-网络链路', '192.168.1.254',
        [{ kind: 'ping' }],
        '示例模板(默认停用): 链路只看可达性/时延/丢包, 填对端网关或骨干节点 IP。'],
      ['app', '示例-应用服务', '192.168.1.50',
        [{ kind: 'tcp', params: { port: 8080 } }, { kind: 'http', params: { url: 'http://192.168.1.50:8080/health' } }],
        '示例模板(默认停用): 应用建议填健康检查 URL, 状态码 2xx/3xx 视为正常。'],
      ['other', '示例-其他设备', '192.168.1.99',
        [{ kind: 'ping' }],
        '示例模板(默认停用): 其它 IP 设备至少可以用 Ping 监控。'],
    ];
    for (const [type, name, address, checks, note] of defs) {
      const id = this.addTarget({ name, type, address, interval_sec: 60, enabled: 0, note });
      this.setChecks(id, checks);
    }
    this.meta.flags.examples_seeded = 1;
    this.meta.save();
    return defs.length;
  }

  seedProbeTriggers() {
    const T = this.meta.tables.triggers;
    const defs = [
      ['探测丢包过高', 'ping.loss', '>', 50, 2, 'critical'],
      ['探测时延过高', 'ping.latency', '>', 200, 3, 'warning'],
      ['端口不通', 'tcp.open', '=', 0, 2, 'critical'],
      ['数据库连接失败', 'db.ok', '=', 0, 1, 'critical'],
      ['HTTP服务异常', 'http.ok', '=', 0, 2, 'warning'],
      ['SNMP不可达', 'snmp.up', '=', 0, 2, 'warning'],
    ];
    let added = false;
    for (const d of defs) {
      if (T.some(t => t.name === d[0])) continue;
      T.push({
        id: this.meta.nextId('triggers'), name: d[0], item: d[1], op: d[2],
        threshold: d[3], duration: d[4], severity: d[5], host_id: null, enabled: 1,
      });
      added = true;
    }
    if (added) this.meta.save();
  }

  // ---- 历史 ----
  insertHistory(hostId, metrics, ts) { return this.series.append(hostId, metrics, ts); }
  getLatest(hostId) { return this.series.latest(hostId); }
  getItems(hostId) { return this.series.items(hostId); }
  getHistory(hostId, item, fromTs, toTs, maxPoints = 600) {
    return this.series.range(hostId, item, fromTs, toTs, maxPoints);
  }
  lastValues(hostId, item, n) { return this.series.lastValues(hostId, item, n); }
  cleanupHistory(beforeTs) { return this.series.cleanup(beforeTs); }
  countHistory() { return this.series.count(); }

  // ---- 触发器 ----
  seedTriggers() {
    const T = this.meta.tables.triggers;
    if (T.length > 0) return;
    const defs = [
      ['CPU使用率过高', 'cpu.util', '>', 90, 3, 'critical'],
      ['内存使用率过高', 'mem.used_pct', '>', 90, 3, 'warning'],
      ['磁盘空间不足', 'disk.used_pct*', '>', 90, 1, 'warning'],
    ];
    for (const d of defs) {
      T.push({
        id: this.meta.nextId('triggers'), name: d[0], item: d[1], op: d[2],
        threshold: d[3], duration: d[4], severity: d[5], host_id: null, enabled: 1,
      });
    }
    this.meta.save();
  }

  getTriggers() {
    const hosts = this.meta.tables.hosts;
    return this.meta.tables.triggers.slice().sort(byId).map(t => {
      const out = copy(t);
      const h = t.host_id == null ? null : hosts.find(x => x.id === t.host_id);
      out.host_name = h ? h.name : null;
      return out;
    });
  }
  getTrigger(id) { const t = this.meta.tables.triggers.find(x => x.id === id); return t ? copy(t) : undefined; }
  addTrigger(t) {
    const id = this.meta.nextId('triggers');
    this.meta.tables.triggers.push({
      id, name: t.name, item: t.item, op: t.op, threshold: t.threshold, duration: t.duration,
      severity: t.severity, host_id: t.host_id == null ? null : t.host_id, enabled: t.enabled ? 1 : 0,
    });
    this.meta.save();
    return id;
  }
  updateTrigger(id, t) {
    const row = this.meta.tables.triggers.find(x => x.id === id);
    if (!row) return;
    row.name = t.name; row.item = t.item; row.op = t.op; row.threshold = t.threshold;
    row.duration = t.duration; row.severity = t.severity;
    row.host_id = t.host_id == null ? null : t.host_id; row.enabled = t.enabled ? 1 : 0;
    this.meta.save();
  }
  deleteTrigger(id) {
    const T = this.meta.tables;
    T.alerts = T.alerts.filter(a => a.trigger_id !== id);
    T.triggers = T.triggers.filter(x => x.id !== id);
    this.meta.save();
  }

  // ---- 告警 ----
  getActiveAlert(triggerId, hostId, item) {
    const a = this.meta.tables.alerts.find(x =>
      x.trigger_id === triggerId && x.host_id === hostId && x.item === item && x.status === 'active');
    return a ? copy(a) : undefined;
  }
  fireAlert(a) {
    const id = this.meta.nextId('alerts');
    this.meta.tables.alerts.push({
      id, trigger_id: a.trigger_id, host_id: a.host_id, item: a.item, start_ts: a.ts,
      end_ts: null, status: 'active', value: a.value == null ? null : a.value, message: a.message,
    });
    this.meta.save();
    return id;
  }
  resolveAlert(id, ts, value) {
    const a = this.meta.tables.alerts.find(x => x.id === id);
    if (!a) return;
    a.status = 'resolved'; a.end_ts = ts; a.value = value == null ? null : value;
    this.meta.save();
  }
  updateAlertValue(id, value) {
    const a = this.meta.tables.alerts.find(x => x.id === id);
    if (a && a.value !== value) { a.value = value; this.meta.touch(); }
  }
  cleanupAlerts(beforeTs) {
    const T = this.meta.tables;
    const before = T.alerts.length;
    T.alerts = T.alerts.filter(a => !(a.status === 'resolved' && a.end_ts != null && a.end_ts < beforeTs));
    const removed = before - T.alerts.length;
    if (removed > 0) this.meta.save();
    return removed;
  }
  getAlerts(status, limit = 200) {
    const T = this.meta.tables;
    let list = T.alerts;
    if (status === 'active') list = list.filter(a => a.status === 'active');
    return list.slice().sort((a, b) => b.start_ts - a.start_ts || b.id - a.id).slice(0, limit).map(a => {
      const out = copy(a);
      const h = T.hosts.find(x => x.id === a.host_id);
      const t = T.triggers.find(x => x.id === a.trigger_id);
      out.host_name = h ? h.name : null;
      out.host_muted = h ? h.alert_muted : 0;
      out.trigger_name = t ? t.name : null;
      out.severity = t ? t.severity : null;
      return out;
    });
  }
  activeAlertCount(hostId) {
    return this.meta.tables.alerts.filter(a => a.status === 'active' && a.host_id === hostId).length;
  }
  resolveOfflineAlert(hostId, ts) {
    const a = this.meta.tables.alerts.find(x => x.trigger_id === 0 && x.host_id === hostId && x.status === 'active');
    if (a) { this.resolveAlert(a.id, ts, null); return copy(a); }
    return undefined;
  }
  getOfflineAlert(hostId) {
    const a = this.meta.tables.alerts.find(x => x.trigger_id === 0 && x.host_id === hostId && x.status === 'active');
    return a ? copy(a) : undefined;
  }
}

module.exports = DB;