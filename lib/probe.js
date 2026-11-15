'use strict';
const net = require('node:net');
const { execFile } = require('node:child_process');
const dbcheck = require('./dbcheck');
const snmp = require('./snmp');

const IS_WIN = process.platform === 'win32';
const snmpPrev = new Map();

function ping(host, count = 4, timeoutMs = 1000) {
  return new Promise(resolve => {
    const args = IS_WIN
      ? ['-n', String(count), '-w', String(timeoutMs), host]
      : ['-c', String(count), '-W', String(Math.ceil(timeoutMs / 1000)), host];
    execFile('ping', args, { timeout: count * timeoutMs + 5000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      const received = (out.match(/TTL=/gi) || []).length;
      const loss = Math.round((count - Math.min(count, received)) / count * 100);
      const times = [...out.matchAll(/(?:time|时间)[=<]\s*([\d.]+)\s*ms/gi)].map(m => parseFloat(m[1]));
      const latency = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length * 100) / 100 : (received > 0 ? 0 : null);
      resolve({ ok: received > 0 ? 1 : 0, latency, loss });
    });
  });
}

function tcp(host, port, timeout = 5000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve({ open: 0, time: timeout }); }, timeout);
    s.once('connect', () => { clearTimeout(t); const time = Date.now() - t0; s.destroy(); resolve({ open: 1, time }); });
    s.once('error', () => { clearTimeout(t); resolve({ open: 0, time: Date.now() - t0 }); });
  });
}

async function http(url, timeout = 8000) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    const time = Date.now() - t0;
    return { ok: resp.status >= 200 && resp.status < 400 ? 1 : 0, status: resp.status, time };
  } catch (e) {
    return { ok: 0, status: 0, time: Date.now() - t0 };
  }
}

async function snmpCheck(target, p) {
  const port = p.port || 161;
  const community = p.community || 'public';
  const version = p.version || '2c';
  const oids = [snmp.OID.sysUpTime];
  if (p.ifIndex) {
    oids.push(snmp.OID.ifOperStatus(p.ifIndex), snmp.OID.ifHCInOctets(p.ifIndex), snmp.OID.ifHCOutOctets(p.ifIndex), snmp.OID.ifInOctets(p.ifIndex), snmp.OID.ifOutOctets(p.ifIndex));
  }
  if (p.cpuOid) oids.push(p.cpuOid);
  const res = await snmp.get(target.address, port, community, oids, version, 4000);
  if (res.error) throw new Error('SNMP 错误码 ' + res.error);
  const v = res.values;
  const m = { 'snmp.up': 1, 'snmp.uptime': Math.floor((v[snmp.OID.sysUpTime] || 0) / 100) };
  if (p.ifIndex) {
    m['snmp.ifup'] = v[snmp.OID.ifOperStatus(p.ifIndex)] === 1 ? 1 : 0;
    const inC = v[snmp.OID.ifHCInOctets(p.ifIndex)] ?? v[snmp.OID.ifInOctets(p.ifIndex)];
    const outC = v[snmp.OID.ifHCOutOctets(p.ifIndex)] ?? v[snmp.OID.ifOutOctets(p.ifIndex)];
    const key = target.id + ':' + p.ifIndex;
    const now = Date.now();
    const prev = snmpPrev.get(key);
    if (prev && inC != null && outC != null) {
      const dt = (now - prev.ts) / 1000;
      if (dt > 0) {
        let din = inC - prev.in, dout = outC - prev.out;
        if (din < 0) din += Math.pow(2, 32);
        if (dout < 0) dout += Math.pow(2, 32);
        m['snmp.in'] = Math.max(0, Math.round(din / dt));
        m['snmp.out'] = Math.max(0, Math.round(dout / dt));
      }
    }
    snmpPrev.set(key, { in: inC, out: outC, ts: now });
  }
  if (p.cpuOid && v[p.cpuOid] != null) m['snmp.cpu'] = Number(v[p.cpuOid]);
  return m;
}

async function runTarget(target, checks) {
  const m = {};
  const errors = [];
  const host = target.address;
  await Promise.all(checks.map(async c => {
    const p = c.params || {};
    try {
      if (c.kind === 'ping') {
        const r = await ping(host, p.count || 4);
        m['ping.ok'] = r.ok; m['ping.loss'] = r.loss;
        if (r.latency != null) m['ping.latency'] = r.latency;
        if (!r.ok) errors.push('ping 不通');
      } else if (c.kind === 'tcp') {
        const r = await tcp(host, p.port || 80);
        m['tcp.open'] = r.open; m['tcp.time'] = r.time;
        if (!r.open) errors.push(`端口 ${p.port || 80} 不通`);
      } else if (c.kind === 'http') {
        const url = p.url || `http://${host}`;
        const r = await http(url);
        m['http.ok'] = r.ok; m['http.status'] = r.status; m['http.time'] = r.time;
        if (!r.ok) errors.push(`HTTP ${r.status || '失败'}`);
      } else if (c.kind === 'db') {
        const r = await dbcheck.check({ host, ...p });
        m['db.ok'] = r.ok; m['db.time'] = r.time;
        if (!r.ok) errors.push('数据库: ' + r.error);
      } else if (c.kind === 'snmp') {
        Object.assign(m, await snmpCheck(target, p));
      }
    } catch (e) {
      errors.push(`${c.kind}: ${e.message}`);
      if (c.kind === 'snmp') m['snmp.up'] = 0;
      if (c.kind === 'db') { m['db.ok'] = 0; }
    }
  }));
  return { metrics: m, error: errors.join('; ') };
}

module.exports = { runTarget, ping, tcp, http, _snmpPrev: snmpPrev };