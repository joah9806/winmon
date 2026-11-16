'use strict';
const { itemMeta } = require('./metrics');
const { sendMail } = require('./mailer');
const httpc = require('./httpc');

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
    await httpc.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 8000,
    });
  } catch (e) {
    console.error('[webhook] 推送失败:', e.message);
  }
}

function notify(cfg, payload, subject, text) {
  sendWebhook(cfg.webhook_url, payload);
  if (cfg.mail && cfg.mail.enabled) {
    sendMail(cfg.mail, { subject, text }).catch(e => console.error('[邮件] 发送失败:', e.message));
  }
}

function evaluate(db, host, metrics, ts, cfg) {
  if (host.alert_muted) return;
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
        notify(cfg, {
          event: 'fire', severity: t.severity, severity_name: SEVERITY_NAME[t.severity] || t.severity,
          host: host.name, trigger: t.name, item: meta.name, value, threshold: t.threshold,
          op: t.op, message, ts,
        }, `[WinMon告警] ${SEVERITY_NAME[t.severity] || t.severity} · ${host.name} · ${t.name}`,
          `${message}\n\n主机: ${host.name}\n触发器: ${t.name}\n级别: ${SEVERITY_NAME[t.severity] || t.severity}\n指标: ${meta.name}\n时间: ${new Date(ts).toLocaleString('zh-CN', { hour12: false })}\n\n— WinMon 监控系统`);
      } else if (!bad && active) {
        db.resolveAlert(active.id, ts, value);
        const message = `${host.name}: ${t.name} [${meta.name}] 已恢复正常, 当前 ${fmtValue(item, value)}`;
        console.log(`[恢复] ${message}`);
        notify(cfg, {
          event: 'resolve', severity: t.severity, host: host.name, trigger: t.name,
          item: meta.name, value, message, ts,
        }, `[WinMon恢复] ${host.name} · ${t.name}`,
          `${message}\n\n主机: ${host.name}\n触发器: ${t.name}\n时间: ${new Date(ts).toLocaleString('zh-CN', { hour12: false })}\n\n— WinMon 监控系统`);
      } else if (bad && active) {
        db.updateAlertValue(active.id, value);
      }
    }
  }
}

function checkOffline(db, hosts, now, timeoutMs, cfg) {
  for (const h of hosts) {
    if (h.alert_muted) continue;
    const offline = now - h.last_seen > timeoutMs;
    const active = db.getOfflineAlert(h.id);
    if (offline && !active) {
      const message = `${h.name}: 主机离线, 超过 ${Math.round(timeoutMs / 1000)} 秒未上报数据`;
      db.fireAlert({ trigger_id: 0, host_id: h.id, item: 'agent.online', ts: now, value: 0, message });
      console.log(`[告警] ${message}`);
      notify(cfg, { event: 'fire', severity: 'critical', host: h.name, trigger: '主机离线', message, ts: now },
        `[WinMon告警] 严重 · ${h.name} · 主机离线`,
        `${message}\n\n主机: ${h.name}\n时间: ${new Date(now).toLocaleString('zh-CN', { hour12: false })}\n\n— WinMon 监控系统`);
    } else if (!offline && active) {
      db.resolveAlert(active.id, now, 1);
      const message = `${h.name}: 主机恢复在线`;
      console.log(`[恢复] ${message}`);
      notify(cfg, { event: 'resolve', severity: 'critical', host: h.name, trigger: '主机离线', message, ts: now },
        `[WinMon恢复] ${h.name} · 主机恢复在线`,
        `${message}\n\n主机: ${h.name}\n时间: ${new Date(now).toLocaleString('zh-CN', { hour12: false })}\n\n— WinMon 监控系统`);
    }
  }
}

module.exports = { evaluate, checkOffline, matchItem, fmtValue, fmtBytes, fmtDuration, SEVERITY_NAME };