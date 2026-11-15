'use strict';
const { itemMeta } = require('./metrics');

const SEVERITY_NAME = { info: '信息', warning: '警告', critical: '严重' };

function matchItem(pattern, item) {
  if (pattern === item) return true;
  if (pattern.endsWith('*')) return item.startsWith(pattern.slice(0, -1));
  return false;
}

function testOp(value, op, threshold) {
  switch (op) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '=': return value === threshold;
    case '!=': return value !== threshold;
    default: return false;
  }
}

function fmtValue(item, v) {
  const meta = itemMeta(item);
  if (meta.unit === 'B') return fmtBytes(v);
  if (meta.unit === 'B/s') return fmtBytes(v) + '/s';
  if (meta.unit === 's') return fmtDuration(v);
  return String(Math.round(v * 100) / 100) + (meta.unit || '');
}

function fmtBytes(v) {
  if (v == null || !isFinite(v)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + units[i];
}

function fmtDuration(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.error('[webhook] 推送失败:', e.message);
  }
}

function evaluate(db, host, metrics, ts, webhookUrl) {
  const triggers = db.getTriggers().filter(t => t.enabled && (t.host_id == null || t.host_id === host.id));
  for (const t of triggers) {
    for (const [item, value] of Object.entries(metrics)) {
      if (!matchItem(t.item, item)) continue;
      const need = Math.max(1, t.duration);
      const values = db.lastValues(host.id, item, need);
      const bad = values.length >= need && values.every(v => testOp(v, t.op, t.threshold));
      const active = db.getActiveAlert(t.id, host.id, item);
      const meta = itemMeta(item);
      if (bad && !active) {
        const message = `${host.name}: ${t.name} [${meta.name}] 连续${need}次 ${t.op} ${t.threshold}${meta.unit === '%' ? '%' : ''}, 当前 ${fmtValue(item, value)}`;
        db.fireAlert({ trigger_id: t.id, host_id: host.id, item, ts, value, message });
        console.log(`[告警] ${message}`);
        sendWebhook(webhookUrl, {
          event: 'fire', severity: t.severity, severity_name: SEVERITY_NAME[t.severity] || t.severity,
          host: host.name, trigger: t.name, item: meta.name, value, threshold: t.threshold,
          op: t.op, message, ts,
        });
      } else if (!bad && active) {
        db.resolveAlert(active.id, ts, value);
        const message = `${host.name}: ${t.name} [${meta.name}] 已恢复正常, 当前 ${fmtValue(item, value)}`;
        console.log(`[恢复] ${message}`);
        sendWebhook(webhookUrl, {
          event: 'resolve', severity: t.severity, host: host.name, trigger: t.name,
          item: meta.name, value, message, ts,
        });
      } else if (bad && active) {
        db.db.prepare('UPDATE alerts SET value=? WHERE id=?').run(value, active.id);
      }
    }
  }
}

function checkOffline(db, hosts, now, timeoutMs, webhookUrl) {
  for (const h of hosts) {
    const offline = now - h.last_seen > timeoutMs;
    const active = db.getOfflineAlert(h.id);
    if (offline && !active) {
      const message = `${h.name}: 主机离线, 超过 ${Math.round(timeoutMs / 1000)} 秒未上报数据`;
      db.fireAlert({ trigger_id: 0, host_id: h.id, item: 'agent.online', ts: now, value: 0, message });
      console.log(`[告警] ${message}`);
      sendWebhook(webhookUrl, { event: 'fire', severity: 'critical', host: h.name, trigger: '主机离线', message, ts: now });
    } else if (!offline && active) {
      db.resolveAlert(active.id, now, 1);
      const message = `${h.name}: 主机恢复在线`;
      console.log(`[恢复] ${message}`);
      sendWebhook(webhookUrl, { event: 'resolve', severity: 'critical', host: h.name, trigger: '主机离线', message, ts: now });
    }
  }
}

module.exports = { evaluate, checkOffline, matchItem, fmtValue, fmtBytes, fmtDuration, SEVERITY_NAME };