'use strict';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const state = {
  view: 'dashboard', hostId: null, item: 'cpu.util', range: 3600,
  alertsMode: 'active', triggers: [], hosts: [], catalog: null, modalOpen: false,
  probeSearch: '', _restoreSearch: false,
  selProbes: new Set(),
};

const DEVICE_TYPE_NAMES = { camera: '摄像机', switch: '交换机', firewall: '防火墙', controller: '设备控制器', linux: 'Linux服务器', windows: 'Windows电脑', db: '数据库服务器', network: '网络链路', app: '应用服务', other: '其他' };
const TYPE_COLORS = { camera: '#4f8cff', switch: '#2ecc71', firewall: '#ff5c5c', controller: '#ffa940', linux: '#9b8cff', windows: '#3fb6e8', db: '#e879b9', network: '#5ad1c9', app: '#c9d14f', other: '#8493b8' };
const CHECK_NAMES = { ping: 'Ping', tcp: '端口', http: 'HTTP', snmp: 'SNMP', db: '数据库' };

function ipKey(addr) {
  const m = String(addr || '').match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
  if (m) return m.slice(1, 5).reduce((a, o) => a * 256 + Math.min(255, Number(o)), 0);
  return Number.MAX_SAFE_INTEGER;
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function accentAlpha(a) {
  const h = cssVar('--accent').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#themeToggle');
  if (b) b.textContent = t === 'light' ? '深色' : '浅色';
}
applyTheme(localStorage.getItem('winmon-theme') || 'dark');
let serverStopped = false;
let restarting = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

function fmtBytes(v) {
  if (v == null || !isFinite(v)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + u[i];
}

function fmtDuration(sec) {
  if (sec == null) return '-';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分钟`;
  return `${sec}秒`;
}

function itemMeta(item) {
  if (state.catalog && state.catalog.items[item]) return state.catalog.items[item];
  const disk = item.match(/^disk\.(used_pct|free|total)\[(.+)\]$/);
  if (disk) {
    const names = { used_pct: '磁盘使用率', free: '磁盘剩余空间', total: '磁盘总空间' };
    return { name: `${names[disk[1]]}(${disk[2]})`, unit: disk[1] === 'used_pct' ? '%' : 'B' };
  }
  return { name: item, unit: '' };
}

function fmtVal(item, v) {
  if (v == null || !isFinite(v)) return '-';
  const unit = itemMeta(item).unit;
  if (unit === '%') return v.toFixed(1) + '%';
  if (unit === 'B') return fmtBytes(v);
  if (unit === 'B/s') return fmtBytes(v) + '/s';
  if (unit === 's') return fmtDuration(v);
  return String(Math.round(v * 100) / 100);
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function fmtAgo(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + '秒前';
  if (s < 3600) return Math.floor(s / 60) + '分钟前';
  if (s < 86400) return Math.floor(s / 3600) + '小时前';
  return Math.floor(s / 86400) + '天前';
}

function barClass(v) { return v >= 90 ? 'bad' : v >= 70 ? 'warn' : ''; }

function meter(label, v) {
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  return `<div class="meter"><div class="lab"><span>${esc(label)}</span><b>${v == null ? '-' : v.toFixed(1) + '%'}</b></div>
    <div class="bar"><i class="${barClass(pct)}" style="width:${pct}%"></i></div></div>`;
}

function sevBadge(sev) {
  const names = { critical: '严重', warning: '警告', info: '信息' };
  return `<span class="sev ${esc(sev || 'critical')}">${esc(names[sev] || sev || '严重')}</span>`;
}

/* ---------- 筛选 / 导入导出 ---------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stripTarget(t) {
  return {
    name: t.name, type: t.type, address: t.address, interval_sec: t.interval_sec,
    enabled: !!t.enabled, note: t.note || '',
    checks: (t.checks || []).map(c => ({ kind: c.kind, params: c.params || {}, enabled: c.enabled !== false })),
  };
}

async function decodeText(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gbk').decode(buf); }
}

const CSV_COLS = ['name', 'type', 'address', 'interval_sec', 'enabled', 'ping', 'tcp_port', 'http_url', 'snmp_community', 'snmp_version', 'snmp_ifindex', 'snmp_cpu_oid', 'db_type', 'db_port', 'db_user', 'db_password', 'db_name', 'note'];

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function targetsToCSV(targets) {
  const lines = [CSV_COLS.join(',')];
  for (const t of targets) {
    const c = k => (t.checks || []).find(x => x.kind === k) || null;
    const p = k => (c(k) || {}).params || {};
    const row = {
      name: t.name, type: t.type, address: t.address, interval_sec: t.interval_sec, enabled: t.enabled ? 1 : 0,
      ping: c('ping') ? 1 : 0, tcp_port: p('tcp').port ?? '', http_url: p('http').url || '',
      snmp_community: c('snmp') ? (p('snmp').community || 'public') : '', snmp_version: p('snmp').version || '2c',
      snmp_ifindex: p('snmp').ifIndex ?? '', snmp_cpu_oid: p('snmp').cpuOid || '',
      db_type: p('db').dbtype || '', db_port: p('db').port ?? '', db_user: p('db').user || '',
      db_password: p('db').password || '', db_name: p('db').db || '', note: t.note || '',
    };
    lines.push(CSV_COLS.map(k => csvEscape(row[k])).join(','));
  }
  return lines.join('\r\n');
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function truthy(v) { return /^(1|true|yes|y|on|是)$/i.test(String(v ?? '').trim()); }

function csvToTargets(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const idx = {}; CSV_COLS.forEach(c => { idx[c] = header.indexOf(c); });
  const get = (r, c) => idx[c] >= 0 ? String(r[idx[c]] ?? '').trim() : '';
  const out = [];
  for (const r of rows.slice(1)) {
    const name = get(r, 'name'), address = get(r, 'address');
    if (!name || !address) continue;
    const checks = [];
    if (truthy(get(r, 'ping'))) checks.push({ kind: 'ping', params: {} });
    if (get(r, 'tcp_port')) checks.push({ kind: 'tcp', params: { port: Number(get(r, 'tcp_port')) || 80 } });
    if (get(r, 'http_url')) checks.push({ kind: 'http', params: { url: get(r, 'http_url') } });
    if (get(r, 'snmp_community') || get(r, 'snmp_ifindex')) checks.push({ kind: 'snmp', params: { community: get(r, 'snmp_community') || 'public', version: get(r, 'snmp_version') || '2c', ifIndex: get(r, 'snmp_ifindex') ? Number(get(r, 'snmp_ifindex')) : null, cpuOid: get(r, 'snmp_cpu_oid') } });
    if (get(r, 'db_type')) checks.push({ kind: 'db', params: { dbtype: get(r, 'db_type'), port: get(r, 'db_port') ? Number(get(r, 'db_port')) : undefined, user: get(r, 'db_user'), password: get(r, 'db_password'), db: get(r, 'db_name') } });
    if (!checks.length) checks.push({ kind: 'ping', params: {} });
    out.push({ name, type: get(r, 'type') || 'other', address, interval_sec: Number(get(r, 'interval_sec')) || 60, enabled: get(r, 'enabled') === '' ? true : truthy(get(r, 'enabled')), note: get(r, 'note'), checks });
  }
  return out;
}

function normalizeImport(data) {
  const arr = Array.isArray(data) ? data : (Array.isArray(data.targets) ? data.targets : null);
  if (!arr) throw new Error('JSON 需为数组或 {targets:[...]}');
  const out = [];
  for (const t of arr) {
    if (!t || !t.name || !t.address) continue;
    const checks = Array.isArray(t.checks) && t.checks.length
      ? t.checks.filter(c => c && c.kind).map(c => ({ kind: c.kind, params: c.params || {}, enabled: c.enabled !== false }))
      : [{ kind: 'ping', params: {} }];
    out.push({ name: String(t.name), type: t.type || 'other', address: String(t.address), interval_sec: Number(t.interval_sec) || 60, enabled: t.enabled !== false, note: t.note || '', checks });
  }
  return out;
}

function exportModal(targets) {
  openModal(`<h3>导出监控目标</h3>
    <div class="hint">共 ${targets.length} 个目标。JSON 适合备份/迁移; CSV 可用 Excel 编辑后再导入。</div>
    <div class="form-actions"><button class="btn ghost" id="exJson">导出 JSON</button><button class="btn ghost" id="exCsv">导出 CSV</button><button class="btn" id="exClose">关闭</button></div>`);
  $('#exClose').onclick = closeModal;
  $('#exJson').onclick = () => { download('winmon-targets.json', JSON.stringify(targets.map(stripTarget), null, 2), 'application/json'); toast('已导出 JSON'); };
  $('#exCsv').onclick = () => { download('winmon-targets.csv', '\ufeff' + targetsToCSV(targets), 'text/csv'); toast('已导出 CSV'); };
}

function importModal() {
  openModal(`<h3>导入监控目标</h3>
    <div class="hint">支持 JSON(导出格式) 或 CSV(表头见模板)。导入为新增, 不会覆盖现有目标。</div>
    <div class="form-row"><label>选择文件 (.json / .csv)</label><input type="file" id="impFile" accept=".json,.csv,text/csv,application/json"></div>
    <div class="hint"><a href="#" id="impTpl">下载 CSV 模板</a></div>
    <div id="impPreview" class="hint"></div>
    <div class="form-actions"><button class="btn ghost" id="impCancel">取消</button><button class="btn" id="impOk" disabled>确认导入</button></div>`);
  let parsed = [];
  $('#impCancel').onclick = closeModal;
  $('#impTpl').onclick = e => { e.preventDefault(); download('winmon-targets-template.csv', '\ufeff' + targetsToCSV([]), 'text/csv'); };
  $('#impFile').onchange = async e => {
    const f = e.target.files[0]; parsed = []; $('#impOk').disabled = true; $('#impPreview').textContent = '';
    if (!f) return;
    try {
      const text = await decodeText(f);
      const trimmed = text.replace(/^\ufeff/, '').trim();
      if (/\.json$/i.test(f.name) || trimmed.startsWith('[') || trimmed.startsWith('{')) parsed = normalizeImport(JSON.parse(trimmed));
      else parsed = csvToTargets(parseCSV(trimmed));
      $('#impPreview').textContent = parsed.length ? `解析到 ${parsed.length} 个有效目标` : '未解析到有效目标(需 name 与 address)';
      $('#impOk').disabled = !parsed.length;
    } catch (err) { $('#impPreview').textContent = '解析失败: ' + err.message; }
  };
  $('#impOk').onclick = async () => {
    $('#impOk').disabled = true;
    let ok = 0, fail = 0; const errs = [];
    for (const t of parsed) {
      try { await api('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }); ok++; }
      catch (e) { fail++; errs.push(t.name + ': ' + e.message); }
    }
    closeModal();
    toast(`导入完成: 成功 ${ok}, 失败 ${fail}`, fail > 0);
    if (errs.length) {
      openModal(`<h3>导入失败明细</h3><div class="code">${esc(errs.join('\n'))}</div><div class="form-actions"><button class="btn" id="ieClose">关闭</button></div>`);
      $('#ieClose').onclick = closeModal;
    }
    renderProbes();
  };
}

/* ---------- 视图渲染 ---------- */

async function render() {
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'host') return renderHost();
  if (state.view === 'probes') return renderProbes();
  if (state.view === 'alerts') return renderAlerts();
  if (state.view === 'triggers') return renderTriggers();
}

async function renderDashboard() {
  let hosts, stats;
  try {
    [hosts, stats] = await Promise.all([api('/api/hosts'), api('/api/stats')]);
  } catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  state.hosts = hosts;
  const online = hosts.filter(h => h.online).length;
  main.innerHTML = `
    <div class="summary">
      <div class="stat"><div class="v">${hosts.length}</div><div class="k">主机总数</div></div>
      <div class="stat"><div class="v" style="color:var(--green)">${online}</div><div class="k">在线</div></div>
      <div class="stat ${hosts.length - online > 0 ? 'bad' : ''}"><div class="v">${hosts.length - online}</div><div class="k">离线</div></div>
      <div class="stat ${stats.active_alerts > 0 ? 'bad' : ''}"><div class="v">${stats.active_alerts}</div><div class="k">活动告警</div></div>
      <div class="stat"><div class="v">${(stats.points / 10000).toFixed(1)}万</div><div class="k">历史数据点</div></div>
    </div>
    <div class="grid">${hosts.map(hostCard).join('') || '<div class="empty">暂无主机, 等待 Agent 上报...</div>'}</div>`;
  main.querySelectorAll('.card').forEach(c => c.onclick = () => openHost(Number(c.dataset.id)));
}

function hostCard(h) {
  if (h.kind === 'probe') return probeCard(h);
  return `<div class="card" data-id="${h.id}">
    <div class="title"><span class="dot ${h.online ? 'on' : 'off'}"></span><b>${esc(h.name)}</b>
      ${h.alerts > 0 ? `<span class="badge">${h.alerts} 条告警</span>` : '<span class="badge ok">正常</span>'}</div>
    <div class="sub">${esc(h.ip || '-')} · ${esc(h.os || '-')}</div>
    ${meter('CPU', h.cpu_util)}
    ${meter('内存', h.mem_pct)}
    ${meter('磁盘(最高)', h.disk_max)}
    <div class="foot"><span>↓ ${fmtBytes(h.net_in)}/s ↑ ${fmtBytes(h.net_out)}/s</span><span>运行 ${fmtDuration(h.uptime)}</span></div>
    <div class="foot"><span>最后上报: ${fmtAgo(h.last_seen)}</span></div>
  </div>`;
}

function probeStatus(h) {
  const oks = [h.ping_ok, h.tcp_open, h.http_ok, h.db_ok, h.snmp_up].filter(v => v != null);
  if (!oks.length) return { ok: h.online };
  return { ok: oks.every(v => v === 1) };
}

function probeCard(h) {
  const st = probeStatus(h);
  const rows = [];
  if (h.ping_latency != null || h.ping_loss != null) rows.push(['Ping', `${h.ping_latency != null ? h.ping_latency + 'ms' : '-'} / 丢包${h.ping_loss ?? '-'}%`]);
  if (h.tcp_open != null) rows.push(['端口', h.tcp_open ? '开放' : '不通']);
  if (h.db_ok != null) rows.push(['数据库', h.db_ok ? '连接正常' : '连接失败']);
  if (h.http_ok != null) rows.push(['HTTP', h.http_ok ? '正常' : '异常']);
  if (h.snmp_in != null || h.snmp_out != null) rows.push(['带宽', `↓${fmtBytes(h.snmp_in)}/s ↑${fmtBytes(h.snmp_out)}/s`]);
  return `<div class="card" data-id="${h.id}">
    <div class="title"><span class="dot ${st.ok ? 'on' : 'off'}"></span><b>${esc(h.name)}</b>
      ${h.alerts > 0 ? `<span class="badge">${h.alerts} 条告警</span>` : (st.ok ? '<span class="badge ok">正常</span>' : '<span class="badge">异常</span>')}</div>
    <div class="sub">${esc(h.ip || '-')} · ${esc(DEVICE_TYPE_NAMES[h.dtype] || h.dtype || '设备')}</div>
    ${rows.map(([k, v]) => `<div class="meter"><div class="lab"><span>${esc(k)}</span><b>${esc(v)}</b></div></div>`).join('')}
    <div class="foot"><span>最后探测: ${fmtAgo(h.last_seen)}</span></div>
  </div>`;
}

async function renderProbes() {
  let targets, hosts, stats;
  try { [targets, hosts, stats] = await Promise.all([api('/api/targets'), api('/api/hosts'), api('/api/stats')]); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  const hmap = {};
  for (const h of hosts) hmap[h.host_key] = h;
  const q = state.probeSearch.trim().toLowerCase();
  const filtered = q
    ? targets.filter(t => (t.name || '').toLowerCase().includes(q) || (t.address || '').toLowerCase().includes(q))
    : targets.slice();
  state.selProbes = new Set([...state.selProbes].filter(id => targets.some(t => t.id === id)));

  const groups = {};
  for (const t of filtered) (groups[t.type] = groups[t.type] || []).push(t);
  const typeOrder = Object.keys(DEVICE_TYPE_NAMES).filter(k => groups[k]);
  for (const k of Object.keys(groups)) if (!typeOrder.includes(k)) typeOrder.push(k);
  let rowsHtml = '';
  for (const k of typeOrder) {
    const list = groups[k].sort((a, b) =>
      ipKey(a.address) - ipKey(b.address) || String(a.address).localeCompare(String(b.address)) || a.name.localeCompare(b.name));
    const color = TYPE_COLORS[k] || TYPE_COLORS.other;
    rowsHtml += `<tr class="group-row"><td colspan="10"><span class="grp-mark" style="background:${color}"></span>${esc(DEVICE_TYPE_NAMES[k] || k)}<span class="grp-count">${list.length}</span></td></tr>`;
    for (const t of list) {
      const h = hmap['probe:' + t.id];
      const st = h ? probeStatus(h) : { ok: true };
      rowsHtml += `<tr>
        <td><input type="checkbox" class="row-sel" data-sel="${t.id}" ${state.selProbes.has(t.id) ? 'checked' : ''}></td>
        <td><b>${esc(t.name)}</b></td>
        <td>${esc(DEVICE_TYPE_NAMES[t.type] || t.type)}</td>
        <td>${esc(t.address)}</td>
        <td>${t.checks.map(c => CHECK_NAMES[c.kind] || c.kind).join(' + ')}</td>
        <td>${t.interval_sec}s</td>
        <td><span class="dot ${st.ok ? 'on' : 'off'}"></span> ${st.ok ? '正常' : '异常'}</td>
        <td style="max-width:220px;color:var(--red)">${esc(t.last_error || '')}</td>
        <td><label class="switch"><input type="checkbox" data-en="${t.id}" ${t.enabled ? 'checked' : ''}><i></i></label></td>
        <td style="white-space:nowrap">
          <button class="btn ghost sm" data-test="${t.id}">测试</button>
          <button class="btn ghost sm" data-edit="${t.id}">编辑</button>
          <button class="btn danger sm" data-del="${t.id}">删除</button>
        </td>
      </tr>`;
    }
  }
  if (!rowsHtml) rowsHtml = `<tr><td colspan="10" class="empty">${q ? '没有匹配的设备' : '暂无监控目标, 点击"新建监控目标"添加'}</td></tr>`;
  const origin = location.origin;
  main.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="addTarget">+ 新建监控目标</button>
      <button class="btn ghost" id="impTargets">导入</button>
      <button class="btn ghost" id="expTargets">导出</button>
      <input type="text" id="probeSearch" placeholder="搜索名称 / IP地址" style="width:220px" value="${esc(state.probeSearch)}">
      <div class="spacer"></div>
      <span class="hint">共 ${targets.length} 台设备${q ? `, 匹配 ${filtered.length} 台` : ''} · 按类型分组 · IP 排序</span>
    </div>
    <div class="toolbar" id="probeBulk" style="display:none">
      <span class="hint">已选 <b id="probeSelCount">0</b> 项</span>
      <button class="btn ghost sm" id="bulkEditProbes">批量修改</button>
      <button class="btn danger sm" id="bulkDelProbes">批量删除</button>
      <button class="btn ghost sm" id="bulkClearProbes">清除选择</button>
    </div>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table><thead><tr><th style="width:34px"><input type="checkbox" id="selAllProbes" title="全选"></th><th>名称</th><th>类型</th><th>地址</th><th>探测方式</th><th>间隔</th><th>状态</th><th>最近错误</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>
    </div>
    <div class="panel">
      <h2>接入新主机 (Agent 部署)</h2>
      <div class="hint">
        ${stats.agent_package ? '<a href="/download/agent-package.zip" download>下载 Agent 部署包 (agent-package.zip, 含运行时)</a><br>' : '提示: 在服务端目录运行 make-agent.bat 可生成 agent-package.zip 部署包<br>'}
        1. 将 <b>agent-package.zip</b> 复制到目标 Windows 电脑并解压 (无需安装任何环境);<br>
        2. 修改解压目录中 <b>config.json</b> 的 agent.server_url 为服务端地址, 例如:
        <div class="code">"agent": { "server_url": "${esc(origin.replace('127.0.0.1', '服务端局域网IP'))}" }</div>
        3. 双击 <b>agent.bat</b> 启动, 主机将自动注册并开始上报数据 (出现在"概览"中)。<br>
        注: 若服务端 config.json 中设置了 token, Agent 端需填写相同的 token。<br>
        注: 部署包内含 64 位与 32 位 Node 12 运行时, 启动脚本自动选择, 支持 Windows 7 SP1 及以上。
      </div>
    </div>
    <div class="panel">
      <h2>运行环境要求</h2>
      <div class="hint">
        服务端 / Agent: Windows 7 SP1、8.1、10、11 或 Linux (自带 Node 12 运行时, 无需另装环境)。<br>
        浏览器: Chrome 87+ / Edge 87+ / Firefox 78+。Windows 7 上可用 <b>Chrome 109</b> 或 <b>Firefox 115 ESR</b>;
        IE11 无法运行本界面, 请改用上述浏览器或从局域网内其它设备访问。
      </div>
    </div>
    <div class="panel">
      <h2>启动不了怎么办</h2>
      <div class="hint">
        1. 双击服务端目录的 <b>diagnose.bat</b>, 会生成中文诊断报告 <b>data\\diagnose.txt</b> 并自动打开,
        逐项检查运行时、目录权限、存储、PowerShell、采集脚本、Ping 与端口;<br>
        2. 双击 <b>start-console.bat</b> 以前台方式运行, 报错会直接留在窗口里 (后台启动失败时 start.bat 也会自动转到前台);<br>
        3. 把整个目录放在 <b>D:\\WinMon</b> 这类可写位置。放在「Program Files」或 C 盘根目录时程序目录只读,
        数据与配置会自动改存到 <b>%LOCALAPPDATA%\\WinMon\\data</b>, 诊断报告里会写明实际路径;<br>
        4. Windows 7 需已安装 <b>SP1</b>; 32 位系统需要 <b>runtime\\node-x86.exe</b>, 请完整解压发布包;<br>
        5. 右键 zip → 属性 → <b>解除锁定</b>后再解压, 并确认杀毒软件没有拦截 node.exe。
      </div>
    </div>`;
  const updateProbeBulk = () => {
    const n = state.selProbes.size;
    $('#probeBulk').style.display = n ? 'flex' : 'none';
    $('#probeSelCount').textContent = n;
    const all = $('#selAllProbes');
    const selInView = filtered.filter(t => state.selProbes.has(t.id)).length;
    all.checked = filtered.length > 0 && selInView === filtered.length;
    all.indeterminate = selInView > 0 && selInView < filtered.length;
  };
  updateProbeBulk();
  const search = $('#probeSearch');
  search.oninput = () => {
    state.probeSearch = search.value;
    state._searchCaret = search.selectionStart;
    state._restoreSearch = true;
    renderProbes();
  };
  $('#selAllProbes').onchange = e => {
    for (const t of filtered) e.target.checked ? state.selProbes.add(t.id) : state.selProbes.delete(t.id);
    renderProbes();
  };
  main.querySelectorAll('.row-sel').forEach(cb => cb.onchange = () => {
    const id = Number(cb.dataset.sel);
    cb.checked ? state.selProbes.add(id) : state.selProbes.delete(id);
    updateProbeBulk();
  });
  $('#bulkClearProbes').onclick = () => { state.selProbes.clear(); renderProbes(); };
  $('#bulkDelProbes').onclick = () => {
    const ids = [...state.selProbes];
    confirmModal(`删除所选 ${ids.length} 台设备?`, '其历史数据与告警将一并删除, 探测配置同时移除(不再自动恢复)。', async () => {
      for (const id of ids) await api('/api/targets?id=' + id, { method: 'DELETE' });
      state.selProbes.clear();
      toast(`已删除 ${ids.length} 台设备`); renderProbes();
    });
  };
  $('#bulkEditProbes').onclick = () => bulkEditProbes(targets);
  $('#addTarget').onclick = () => probeForm(null);
  $('#impTargets').onclick = () => importModal();
  $('#expTargets').onclick = () => exportModal(targets);
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => probeForm(targets.find(t => t.id === Number(b.dataset.edit))));
  main.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.test);
    toast('正在测试...');
    try {
      const r = await api('/api/targets/test?id=' + id, { method: 'POST' });
      const lines = Object.entries(r.metrics).map(([k, v]) => `${itemMeta(k).name}: ${fmtVal(k, v)}`).join('\n');
      openModal(`<h3>测试结果</h3><div class="code">${esc(lines || '无指标')}</div>${r.error ? `<div class="hint" style="color:var(--red)">${esc(r.error)}</div>` : '<div class="hint" style="color:var(--green)">全部正常</div>'}<div class="form-actions"><button class="btn" id="tClose">关闭</button></div>`);
      $('#tClose').onclick = closeModal;
    } catch (e) { toast(e.message, true); }
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const t = targets.find(x => x.id === Number(b.dataset.del));
    confirmModal(`删除设备「${esc(t.name)}」?`, '其历史数据与告警将一并删除, 探测配置同时移除(不再自动恢复)。', async () => {
      await api('/api/targets?id=' + t.id, { method: 'DELETE' });
      toast('已删除'); renderProbes();
    });
  });
  main.querySelectorAll('[data-en]').forEach(sw => sw.onchange = async () => {
    const t = targets.find(x => x.id === Number(sw.dataset.en));
    try {
      await api('/api/targets?id=' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...t, enabled: sw.checked }) });
      toast(sw.checked ? '已启用' : '已停用');
    } catch (e) { toast(e.message, true); sw.checked = !sw.checked; }
  });
  if (state._restoreSearch) {
    state._restoreSearch = false;
    search.focus();
    const c = state._searchCaret ?? search.value.length;
    search.setSelectionRange(c, c);
  }
}

function bulkEditProbes(targets) {
  const ids = [...state.selProbes];
  const sel = targets.filter(t => state.selProbes.has(t.id));
  openModal(`
    <h3>批量修改 (${ids.length} 个目标)</h3>
    <div class="hint">留空 / 选择"保持不变"的项不会被修改。</div>
    <div class="form-row"><label>启用状态</label><select id="beEnabled">
      <option value="">保持不变</option><option value="1">启用</option><option value="0">停用</option>
    </select></div>
    <div class="form-row"><label>探测间隔(秒)</label><input type="number" id="beInterval" min="10" max="3600" placeholder="保持不变"></div>
    <div class="form-row"><label>设备类型</label><select id="beType">
      <option value="">保持不变</option>${Object.entries(DEVICE_TYPE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
    </select></div>
    <div class="form-actions"><button class="btn ghost" id="beCancel">取消</button><button class="btn" id="beOk">应用到 ${ids.length} 个目标</button></div>`);
  $('#beCancel').onclick = closeModal;
  $('#beOk').onclick = async () => {
    const changes = {};
    if ($('#beEnabled').value !== '') changes.enabled = $('#beEnabled').value === '1';
    const iv = Number($('#beInterval').value);
    if ($('#beInterval').value.trim() && isFinite(iv)) changes.interval_sec = Math.max(10, Math.min(3600, Math.floor(iv)));
    if ($('#beType').value) changes.type = $('#beType').value;
    if (!Object.keys(changes).length) return toast('未选择任何修改项', true);
    let fail = 0;
    for (const t of sel) {
      try {
        await api('/api/targets?id=' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...t, ...changes }) });
      } catch { fail++; }
    }
    closeModal();
    toast(fail ? `已修改 ${sel.length - fail} 个, ${fail} 个失败` : `已修改 ${sel.length} 个目标`, !!fail);
    renderProbes();
  };
}

function probeForm(t) {
  const get = k => (t ? t.checks.find(c => c.kind === k) : null);
  const has = k => !!get(k);
  const P = k => (get(k) || {}).params || {};
  openModal(`
    <h3>${t ? '编辑监控目标' : '新建监控目标'}</h3>
    <div class="form-row inline">
      <div><label>名称</label><input type="text" id="tName" value="${esc(t?.name || '')}" placeholder="如: 核心交换机"></div>
      <div><label>类型</label><select id="tType">${Object.entries(DEVICE_TYPE_NAMES).map(([k, v]) => `<option value="${k}" ${t?.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="form-row inline">
      <div><label>地址 (IP/域名)</label><input type="text" id="tAddr" value="${esc(t?.address || '')}" placeholder="192.168.1.1"></div>
      <div><label>间隔(秒)</label><input type="number" id="tInterval" min="10" value="${t?.interval_sec ?? 60}"></div>
    </div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ck_ping" ${!t || has('ping') ? 'checked' : ''}> Ping (连通性/时延/丢包)</label></div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ck_tcp" ${has('tcp') ? 'checked' : ''}> TCP 端口</label><input type="number" id="p_tcp_port" placeholder="端口, 如 80/443/3306" value="${P('tcp').port ?? ''}"></div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ck_http" ${has('http') ? 'checked' : ''}> HTTP/HTTPS</label><input type="text" id="p_http_url" placeholder="URL, 留空用 http://地址" value="${esc(P('http').url || '')}"></div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ck_snmp" ${has('snmp') ? 'checked' : ''}> SNMP (带宽/状态/CPU)</label>
      <div class="form-row inline"><div><input type="text" id="p_snmp_com" placeholder="community, 默认public" value="${esc(P('snmp').community || '')}"></div>
      <div><select id="p_snmp_ver"><option value="2c" ${P('snmp').version !== '1' ? 'selected' : ''}>v2c</option><option value="1" ${P('snmp').version === '1' ? 'selected' : ''}>v1</option></select></div>
      <div><input type="number" id="p_snmp_if" placeholder="接口ifIndex(测带宽)" value="${P('snmp').ifIndex ?? ''}"></div></div>
      <input type="text" id="p_snmp_cpu" placeholder="CPU OID(可选)" value="${esc(P('snmp').cpuOid || '')}">
    </div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ck_db" ${has('db') ? 'checked' : ''}> 数据库真实登录</label>
      <div class="form-row inline"><div><select id="p_db_type"><option value="mysql" ${P('db').dbtype === 'mysql' ? 'selected' : ''}>MySQL/MariaDB</option><option value="mssql" ${P('db').dbtype === 'mssql' ? 'selected' : ''}>SQL Server</option><option value="redis" ${P('db').dbtype === 'redis' ? 'selected' : ''}>Redis</option></select></div>
      <div><input type="number" id="p_db_port" placeholder="端口" value="${P('db').port ?? ''}"></div></div>
      <div class="form-row inline"><div><input type="text" id="p_db_user" placeholder="用户名" value="${esc(P('db').user || '')}"></div>
      <div><input type="text" id="p_db_pass" placeholder="密码" value="${esc(P('db').password || '')}"></div>
      <div><input type="text" id="p_db_db" placeholder="库名(可选)" value="${esc(P('db').db || '')}"></div></div>
    </div>
    <div class="form-row"><label class="check"><input type="checkbox" id="tEnabled" ${!t || t.enabled ? 'checked' : ''}> 启用</label></div>
    <div class="form-actions"><button class="btn ghost" id="tCancel">取消</button><button class="btn" id="tSave">保存</button></div>`);
  $('#tCancel').onclick = closeModal;
  $('#tSave').onclick = async () => {
    const checks = [];
    if ($('#ck_ping').checked) checks.push({ kind: 'ping', params: {} });
    if ($('#ck_tcp').checked) checks.push({ kind: 'tcp', params: { port: Number($('#p_tcp_port').value) || 80 } });
    if ($('#ck_http').checked) checks.push({ kind: 'http', params: { url: $('#p_http_url').value.trim() } });
    if ($('#ck_snmp').checked) checks.push({ kind: 'snmp', params: { community: $('#p_snmp_com').value.trim() || 'public', version: $('#p_snmp_ver').value, ifIndex: $('#p_snmp_if').value ? Number($('#p_snmp_if').value) : null, cpuOid: $('#p_snmp_cpu').value.trim() } });
    if ($('#ck_db').checked) checks.push({ kind: 'db', params: { dbtype: $('#p_db_type').value, port: Number($('#p_db_port').value) || undefined, user: $('#p_db_user').value, password: $('#p_db_pass').value, db: $('#p_db_db').value } });
    const body = {
      name: $('#tName').value.trim(), type: $('#tType').value, address: $('#tAddr').value.trim(),
      interval_sec: Number($('#tInterval').value) || 60, enabled: $('#tEnabled').checked, checks,
    };
    if (!body.name || !body.address) return toast('名称和地址不能为空', true);
    if (!checks.length) return toast('至少选择一种探测方式', true);
    try {
      if (t) await api('/api/targets?id=' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      else await api('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('已保存'); closeModal(); renderProbes();
    } catch (e) { toast(e.message, true); }
  };
}

function openHost(id) {
  state.hostId = id;
  state.item = 'cpu.util';
  state.view = 'host';
  syncNav();
  render();
}

async function renderHost() {
  let h;
  try { h = await api('/api/host?id=' + state.hostId); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  if (!h.items.includes(state.item)) state.item = h.items[0] || 'cpu.util';
  const order = ['cpu.util', 'mem.used_pct', 'mem.used', 'mem.available', 'mem.total', 'net.in', 'net.out', 'proc.count', 'sys.uptime'];
  const latest = h.latest.sort((a, b) => {
    const ia = order.indexOf(a.item), ib = order.indexOf(b.item);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.item.localeCompare(b.item);
  });
  main.innerHTML = `
    <div class="detail-head">
      <button class="btn ghost sm" id="backBtn">← 返回概览</button>
      <h2><span class="dot ${h.online ? 'on' : 'off'}"></span> ${esc(h.name)}</h2>
      ${h.alerts > 0 ? `<span class="badge">${h.alerts} 条活动告警</span>` : '<span class="badge ok">正常</span>'}
      <div class="spacer"></div>
      ${h.kind === 'probe' ? '<button class="btn ghost sm" id="cfgHostBtn">探测配置</button>' : '<button class="btn ghost sm" id="renameHostBtn">重命名</button>'}
      <button class="btn danger sm" id="delHostBtn">删除主机</button>
    </div>
    <div class="panel"><div class="kv">
      <div>主机标识: <b>${esc(h.host_key)}</b></div>
      <div>IP 地址: <b>${esc(h.ip || '-')}</b></div>
      <div>操作系统: <b>${esc(h.os || '-')}</b></div>
      <div>CPU: <b>${esc(h.cpu || '-')}</b></div>
      <div>首次接入: <b>${fmtTime(h.first_seen)}</b></div>
      <div>最后上报: <b>${fmtTime(h.last_seen)}</b></div>
    </div></div>
    <div class="panel">
      <div class="toolbar">
        <select id="itemSel">${h.items.map(i => `<option value="${esc(i)}" ${i === state.item ? 'selected' : ''}>${esc(itemMeta(i).name)}</option>`).join('')}</select>
        <div class="seg" id="rangeSeg">
          ${[[3600, '1小时'], [21600, '6小时'], [86400, '24小时'], [604800, '7天']].map(([r, n]) =>
            `<button data-range="${r}" class="${state.range === r ? 'active' : ''}">${n}</button>`).join('')}
        </div>
        <div class="spacer"></div>
        <span class="hint" id="chartInfo"></span>
      </div>
      <div class="chart-wrap"><canvas class="chart" id="chart"></canvas><div class="chart-tip" id="chartTip"></div></div>
    </div>
    <div class="panel">
      <h2>最新指标</h2>
      <table><thead><tr><th>指标</th><th>当前值</th><th>更新时间</th></tr></thead>
      <tbody>${latest.map(r => `<tr><td>${esc(r.meta.name)}</td><td><b>${fmtVal(r.item, r.value)}</b></td><td>${fmtTime(r.ts)}</td></tr>`).join('')}</tbody></table>
    </div>`;
  $('#backBtn').onclick = () => { state.view = 'dashboard'; syncNav(); render(); };
  if (h.kind === 'probe') {
    $('#cfgHostBtn').onclick = async () => {
      const tid = Number(String(h.host_key).slice(6));
      try { const ts = await api('/api/targets'); probeForm(ts.find(t => t.id === tid)); }
      catch (e) { toast(e.message, true); }
    };
  } else {
    $('#renameHostBtn').onclick = () => {
      openModal(`<h3>重命名主机</h3>
        <div class="form-row"><label>显示名称</label><input type="text" id="rnName" value="${esc(h.name)}"></div>
        <div class="form-actions"><button class="btn ghost" id="rnCancel">取消</button><button class="btn" id="rnSave">保存</button></div>`);
      $('#rnCancel').onclick = closeModal;
      $('#rnSave').onclick = async () => {
        const name = $('#rnName').value.trim();
        if (!name) return toast('名称不能为空', true);
        try {
          await api('/api/host?id=' + h.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
          toast('已保存'); closeModal(); renderHost();
        } catch (e) { toast(e.message, true); }
      };
    };
  }
  $('#delHostBtn').onclick = () => {
    const desc = h.kind === 'probe'
      ? '该设备的历史数据、告警与探测配置将一并删除(不再自动恢复)。'
      : '该主机的所有历史数据和告警将被删除, Agent 再次上报时会重新注册。';
    confirmModal(`删除主机「${esc(h.name)}」?`, desc, async () => {
      await api('/api/host?id=' + h.id, { method: 'DELETE' });
      toast('已删除'); state.view = 'dashboard'; syncNav(); render();
    });
  };
  $('#itemSel').onchange = e => { state.item = e.target.value; loadChart(); };
  $('#rangeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.range = Number(b.dataset.range);
    $('#rangeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    loadChart();
  });
  loadChart();
}

async function loadChart() {
  const canvas = $('#chart');
  if (!canvas) return;
  let data;
  try { data = await api(`/api/history?host_id=${state.hostId}&item=${encodeURIComponent(state.item)}&range=${state.range}`); }
  catch (e) { toast(e.message, true); return; }
  $('#chartInfo').textContent = `${data.points.length} 个数据点`;
  drawChart(canvas, data.points, data.item);
}

/* ---------- Canvas 图表 ---------- */

function drawChart(canvas, points, item) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 64, r: 16, t: 16, b: 30 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const meta = itemMeta(item);

  if (!points.length) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', W / 2, H / 2);
    canvas._chart = null;
    return;
  }

  const vals = points.map(p => p.value);
  let ymin = Math.min(...vals), ymax = Math.max(...vals);
  if (meta.unit === '%') { ymin = 0; ymax = 100; }
  else {
    const span = (ymax - ymin) || Math.abs(ymax) * 0.1 || 1;
    ymin = Math.max(0, ymin - span * 0.1);
    ymax = ymax + span * 0.1;
  }
  const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1;
  const x = ts => pad.l + (ts - t0) / Math.max(1, t1 - t0) * cw;
  const y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * ch;

  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = ymin + (ymax - ymin) * i / 4;
    const yy = y(v);
    ctx.strokeStyle = cssVar('--border');
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillStyle = cssVar('--muted');
    ctx.fillText(compactVal(v, meta.unit), pad.l - 8, yy);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ticks = Math.min(6, points.length);
  for (let i = 0; i < ticks; i++) {
    const ts = t0 + (t1 - t0) * i / Math.max(1, ticks - 1);
    const d = new Date(ts);
    const lab = state.range > 86400
      ? `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    ctx.fillStyle = cssVar('--muted');
    ctx.fillText(lab, x(ts), H - pad.b + 8);
  }

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, accentAlpha(.35));
  grad.addColorStop(1, accentAlpha(.02));
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(x(p.ts), y(p.value)) : ctx.moveTo(x(p.ts), y(p.value)));
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.lineTo(x(points[points.length - 1].ts), H - pad.b);
  ctx.lineTo(x(points[0].ts), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(x(last.ts), y(last.value), 3, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--accent');
  ctx.fill();

  canvas._chart = { points, item, x, y, pad, W, H, t0, t1 };
}

function compactVal(v, unit) {
  if (unit === '%') return v.toFixed(0) + '%';
  if (unit === 'B' || unit === 'B/s') return fmtBytes(v);
  if (unit === 's') return fmtDuration(v);
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v * 10) / 10);
}

document.addEventListener('mousemove', e => {
  const canvas = $('#chart');
  const tip = $('#chartTip');
  if (!canvas || !canvas._chart || e.target !== canvas) { if (tip) tip.style.display = 'none'; return; }
  const c = canvas._chart;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  let best = null, bd = Infinity;
  for (const p of c.points) {
    const d = Math.abs(c.x(p.ts) - mx);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best || bd > 40) { tip.style.display = 'none'; return; }
  drawChart(canvas, c.points, c.item);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = cssVar('--muted');
  ctx.globalAlpha = .35;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(c.x(best.ts), c.pad.t); ctx.lineTo(c.x(best.ts), c.H - c.pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(c.x(best.ts), c.y(best.value), 4, 0, Math.PI * 2);
  ctx.fillStyle = cssVar('--strong'); ctx.fill();
  ctx.restore();
  tip.innerHTML = `<div>${fmtTime(best.ts)}</div><b>${fmtVal(c.item, best.value)}</b>`;
  tip.style.display = 'block';
  const tx = Math.min(c.x(best.ts) + 12, c.W - 150);
  tip.style.left = tx + 'px';
  tip.style.top = Math.max(4, c.y(best.value) - 40) + 'px';
});

/* ---------- 告警中心 ---------- */

async function renderAlerts() {
  let alerts;
  try { alerts = await api('/api/alerts?status=' + state.alertsMode); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  main.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="alertSeg">
        <button data-m="active" class="${state.alertsMode === 'active' ? 'active' : ''}">活动告警</button>
        <button data-m="all" class="${state.alertsMode === 'all' ? 'active' : ''}">历史记录</button>
      </div>
      <div class="spacer"></div>
      <span class="hint">共 ${alerts.length} 条 · 每10秒自动刷新</span>
    </div>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table><thead><tr><th>级别</th><th>主机</th><th>触发器</th><th>告警内容</th><th>当前值</th><th>开始时间</th><th>状态</th><th>恢复时间</th></tr></thead>
      <tbody>${alerts.map(a => `<tr>
        <td>${sevBadge(a.severity)}</td>
        <td>${esc(a.host_name || '-')}</td>
        <td>${esc(a.trigger_name || (a.trigger_id === 0 ? '主机离线' : '-'))}</td>
        <td style="max-width:420px">${esc(a.message)}</td>
        <td>${a.item ? fmtVal(a.item, a.value) : '-'}</td>
        <td style="white-space:nowrap">${fmtTime(a.start_ts)}</td>
        <td class="${a.status === 'active' ? 'status-active' : 'status-resolved'}">${a.status === 'active' ? '告警中' : '已恢复'}</td>
        <td style="white-space:nowrap">${a.end_ts ? fmtTime(a.end_ts) : '-'}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无告警</td></tr>'}</tbody></table>
    </div>`;
  $('#alertSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.alertsMode = b.dataset.m;
    renderAlerts();
  });
}

/* ---------- 触发器 ---------- */

async function renderTriggers() {
  let triggers, hosts;
  try { [triggers, hosts] = await Promise.all([api('/api/triggers'), api('/api/hosts')]); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  state.triggers = triggers;
  state.hosts = hosts;
  main.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="addTrig">+ 新建触发器</button>
      <div class="spacer"></div>
      <span class="hint">指标支持通配符, 如 disk.used_pct* 匹配所有磁盘</span>
    </div>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table><thead><tr><th>名称</th><th>监控指标</th><th>触发条件</th><th>连续次数</th><th>级别</th><th>适用主机</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>${triggers.map(t => `<tr>
        <td><b>${esc(t.name)}</b></td>
        <td>${esc(itemMeta(t.item).name)}${t.item.endsWith('*') ? ' (通配)' : ''}</td>
        <td>${esc(t.op)} ${t.threshold}${itemMeta(t.item).unit === '%' ? '%' : ''}</td>
        <td>${t.duration} 次</td>
        <td>${sevBadge(t.severity)}</td>
        <td>${esc(t.host_name || '全部主机')}</td>
        <td><label class="switch"><input type="checkbox" data-id="${t.id}" ${t.enabled ? 'checked' : ''}><i></i></label></td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-edit="${t.id}">编辑</button> <button class="btn danger sm" data-del="${t.id}">删除</button></td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无触发器</td></tr>'}</tbody></table>
    </div>`;
  $('#addTrig').onclick = () => trigForm(null);
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => trigForm(state.triggers.find(t => t.id === Number(b.dataset.edit))));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const t = state.triggers.find(x => x.id === Number(b.dataset.del));
    confirmModal(`删除触发器「${esc(t.name)}」?`, '相关告警记录也会一并删除。', async () => {
      await api('/api/triggers?id=' + t.id, { method: 'DELETE' });
      toast('已删除');
      renderTriggers();
    });
  });
  main.querySelectorAll('.switch input').forEach(sw => sw.onchange = async () => {
    const t = state.triggers.find(x => x.id === Number(sw.dataset.id));
    try {
      await api('/api/triggers?id=' + t.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t, enabled: sw.checked }),
      });
      toast(sw.checked ? '已启用' : '已停用');
    } catch (e) { toast(e.message, true); sw.checked = !sw.checked; }
  });
}

function trigForm(t) {
  const items = state.catalog ? Object.keys(state.catalog.items) : [];
  const options = [...items, 'disk.used_pct*', 'disk.free*', 'net.in', 'net.out'];
  const hosts = state.hosts || [];
  openModal(`
    <h3>${t ? '编辑触发器' : '新建触发器'}</h3>
    <div class="form-row"><label>名称</label><input type="text" id="fName" value="${esc(t?.name || '')}" placeholder="如: CPU使用率过高"></div>
    <div class="form-row"><label>监控指标 (可输入自定义指标键, 支持 * 通配符)</label>
      <input type="text" id="fItem" list="itemList" value="${esc(t?.item || 'cpu.util')}">
      <datalist id="itemList">${[...new Set(options)].map(i => `<option value="${esc(i)}">${esc(itemMeta(i).name)}</option>`).join('')}</datalist>
    </div>
    <div class="form-row inline">
      <div><label>比较符</label><select id="fOp">${['>', '>=', '<', '<=', '=', '!='].map(o => `<option ${t?.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div><label>阈值</label><input type="number" id="fThreshold" step="any" value="${t?.threshold ?? 90}"></div>
      <div><label>连续次数</label><input type="number" id="fDuration" min="1" max="100" value="${t?.duration ?? 3}"></div>
    </div>
    <div class="form-row inline">
      <div><label>级别</label><select id="fSev">
        <option value="info" ${t?.severity === 'info' ? 'selected' : ''}>信息</option>
        <option value="warning" ${!t || t.severity === 'warning' ? 'selected' : ''}>警告</option>
        <option value="critical" ${t?.severity === 'critical' ? 'selected' : ''}>严重</option>
      </select></div>
      <div><label>适用主机</label><select id="fHost">
        <option value="">全部主机</option>
        ${hosts.map(h => `<option value="${h.id}" ${t?.host_id === h.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}
      </select></div>
    </div>
    <div class="form-row"><label class="check"><input type="checkbox" id="fEnabled" ${!t || t.enabled ? 'checked' : ''}> 启用该触发器</label></div>
    <div class="form-actions">
      <button class="btn ghost" id="fCancel">取消</button>
      <button class="btn" id="fSave">保存</button>
    </div>`);
  $('#fCancel').onclick = closeModal;
  $('#fSave').onclick = async () => {
    const body = {
      name: $('#fName').value.trim(), item: $('#fItem').value.trim(),
      op: $('#fOp').value, threshold: Number($('#fThreshold').value),
      duration: Number($('#fDuration').value), severity: $('#fSev').value,
      host_id: $('#fHost').value || null, enabled: $('#fEnabled').checked,
    };
    if (!body.name || !body.item) return toast('名称和指标不能为空', true);
    try {
      if (t) await api('/api/triggers?id=' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      else await api('/api/triggers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      toast('已保存');
      closeModal();
      renderTriggers();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 弹窗 ---------- */

function openModal(html) {
  state.modalOpen = true;
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-mask').onclick = e => { if (e.target.classList.contains('modal-mask')) closeModal(); };
}

function closeModal() {
  state.modalOpen = false;
  $('#modalRoot').innerHTML = '';
}

function confirmModal(title, desc, onOk, okLabel = '确认删除', okClass = 'danger') {
  openModal(`
    <h3>${title}</h3>
    <div class="hint">${desc}</div>
    <div class="form-actions"><button class="btn ghost" id="cCancel">取消</button><button class="btn ${okClass}" id="cOk">${okLabel}</button></div>`);
  $('#cCancel').onclick = closeModal;
  $('#cOk').onclick = async () => {
    try { await onOk(); closeModal(); }
    catch (e) { toast(e.message, true); }
  };
}

/* ---------- 通知设置 ---------- */

async function notifyModal() {
  let cfg;
  try { cfg = await api('/api/notify'); } catch (e) { return toast(e.message, true); }
  const m = cfg.mail || {};
  openModal(`
    <h3>告警通知设置</h3>
    <div class="hint">告警触发与恢复时推送通知。邮件与 Webhook 可同时启用。</div>
    <div class="form-row"><label class="check"><input type="checkbox" id="ntMailEn" ${m.enabled ? 'checked' : ''}> 启用邮件通知 (SMTP)</label></div>
    <div class="form-row inline">
      <div><label>SMTP 服务器</label><input type="text" id="ntHost" value="${esc(m.host || '')}" placeholder="smtp.example.com"></div>
      <div><label>端口</label><input type="number" id="ntPort" value="${m.port || 465}"></div>
      <div><label>加密方式</label><select id="ntSecure">
        <option value="ssl" ${m.secure !== 'starttls' && m.secure !== 'none' ? 'selected' : ''}>SSL (465)</option>
        <option value="starttls" ${m.secure === 'starttls' ? 'selected' : ''}>STARTTLS (587)</option>
        <option value="none" ${m.secure === 'none' ? 'selected' : ''}>无加密 (25)</option>
      </select></div>
    </div>
    <div class="form-row inline">
      <div><label>用户名</label><input type="text" id="ntUser" value="${esc(m.user || '')}" placeholder="登录账号"></div>
      <div><label>密码 / 授权码</label><input type="password" id="ntPass" value="" placeholder="${m.has_pass ? '已保存, 留空保持不变' : 'SMTP 密码或授权码'}"></div>
    </div>
    <div class="form-row inline">
      <div><label>发件人</label><input type="text" id="ntFrom" value="${esc(m.from || '')}" placeholder="默认同用户名"></div>
      <div><label>收件人 (多个用逗号分隔)</label><input type="text" id="ntTo" value="${esc(m.to || '')}" placeholder="a@x.com, b@y.com"></div>
    </div>
    <div class="form-row"><label>Webhook 地址 (可选, 钉钉/企业微信/飞书等机器人)</label><input type="text" id="ntWebhook" value="${esc(cfg.webhook_url || '')}" placeholder="https://..."></div>
    <div class="hint" id="ntMsg"></div>
    <div class="form-actions">
      <button class="btn ghost" id="ntTest">发送测试邮件</button>
      <div style="flex:1"></div>
      <button class="btn ghost" id="ntCancel">取消</button>
      <button class="btn" id="ntSave">保存</button>
    </div>`);
  const defPort = { ssl: 465, starttls: 587, none: 25 };
  $('#ntSecure').onchange = e => { $('#ntPort').value = defPort[e.target.value] || 465; };
  const collect = () => ({
    webhook_url: $('#ntWebhook').value.trim(),
    mail: {
      enabled: $('#ntMailEn').checked, host: $('#ntHost').value.trim(), port: Number($('#ntPort').value) || 465,
      secure: $('#ntSecure').value, user: $('#ntUser').value.trim(), pass: $('#ntPass').value,
      from: $('#ntFrom').value.trim(), to: $('#ntTo').value.trim(),
    },
  });
  const save = () => api('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
  $('#ntCancel').onclick = closeModal;
  $('#ntSave').onclick = async () => {
    try { await save(); toast('通知设置已保存'); closeModal(); }
    catch (e) { toast(e.message, true); }
  };
  $('#ntTest').onclick = async () => {
    const btn = $('#ntTest'); btn.disabled = true;
    $('#ntMsg').style.color = 'var(--muted)'; $('#ntMsg').textContent = '正在保存并发送测试邮件...';
    try {
      await save();
      await api('/api/mail/test', { method: 'POST' });
      $('#ntMsg').style.color = 'var(--green)'; $('#ntMsg').textContent = '测试邮件已发送, 请检查收件箱(含垃圾箱)。';
      $('#ntPass').value = ''; $('#ntPass').placeholder = '已保存, 留空保持不变';
      toast('测试邮件已发送');
    } catch (e) {
      $('#ntMsg').style.color = 'var(--red)'; $('#ntMsg').textContent = e.message;
      toast(e.message, true);
    } finally { btn.disabled = false; }
  };
}

/* ---------- 导航与刷新 ---------- */

function syncNav() {
  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view || (state.view === 'host' && b.dataset.view === 'dashboard')));
}

document.querySelectorAll('#nav button').forEach(b => b.onclick = () => {
  state.view = b.dataset.view;
  syncNav();
  render();
});

$('#themeToggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('winmon-theme', next);
  applyTheme(next);
  render();
};

$('#notifyBtn').onclick = () => notifyModal();

$('#shutdownBtn').onclick = () => {
  confirmModal('停止监控服务?', '服务进程将退出, 本页面随之不可用。之后可双击 start.bat 重新启动。', async () => {
    await api('/api/shutdown', { method: 'POST' });
    serverStopped = true;
    $('#serverStatus').innerHTML = '<span class="dot" style="background:var(--red)"></span>已停止';
    toast('服务已停止');
  }, '确认停止');
};

$('#restartBtn').onclick = () => {
  confirmModal('重启监控服务?', '服务将短暂中断(约 2-3 秒)后自动恢复, 页面会在恢复后自动刷新。', async () => {
    await api('/api/restart', { method: 'POST' });
    restarting = true;
    $('#serverStatus').innerHTML = '<span class="dot" style="background:var(--orange)"></span>重启中...';
    toast('正在重启服务...');
    waitForRestart();
  }, '确认重启', '');
};

async function waitForRestart() {
  const start = Date.now();
  let sawDown = false;
  const tick = async () => {
    if (Date.now() - start > 30000) {
      $('#serverStatus').innerHTML = '<span class="dot" style="background:var(--red)"></span>重启超时';
      toast('重启超时, 请手动刷新页面或检查服务', true);
      return;
    }
    try {
      const h = await api('/api/health');
      if (sawDown || h.uptime < 5) { location.reload(); return; }
    } catch { sawDown = true; }
    setTimeout(tick, 800);
  };
  setTimeout(tick, 1200);
}

async function pollStatus() {
  if (serverStopped || restarting) return;
  const el = $('#serverStatus');
  try {
    const s = await api('/api/stats');
    el.innerHTML = `<span class="dot"></span>运行中 · v${esc(s.version)} · 已运行 ${fmtDuration(s.uptime)}`;
  } catch {
    el.innerHTML = `<span class="dot" style="background:var(--red)"></span>连接失败`;
  }
}

setInterval(() => {
  if (serverStopped || restarting || state.modalOpen) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
  if (['dashboard', 'host', 'alerts', 'probes'].includes(state.view)) render();
}, 10000);

setInterval(pollStatus, 30000);

window.addEventListener('resize', () => {
  const c = $('#chart');
  if (c && c._chart) drawChart(c, c._chart.points, c._chart.item);
});

(async function init() {
  try { state.catalog = await api('/api/catalog'); } catch {}
  pollStatus();
  render();
})();