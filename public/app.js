'use strict';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const state = {
  view: 'dashboard', hostId: null, item: 'cpu.util', range: 3600,
  alertsMode: 'active', triggers: [], hosts: [], catalog: null, modalOpen: false,
};

const DEVICE_TYPE_NAMES = { camera: '摄像机', switch: '交换机', firewall: '防火墙', controller: '设备控制器', linux: 'Linux服务器', windows: 'Windows电脑', db: '数据库服务器', network: '网络链路', app: '应用服务', other: '其他' };
const CHECK_NAMES = { ping: 'Ping', tcp: '端口', http: 'HTTP', snmp: 'SNMP', db: '数据库' };

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

/* ---------- 视图渲染 ---------- */

async function render() {
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'host') return renderHost();
  if (state.view === 'probes') return renderProbes();
  if (state.view === 'alerts') return renderAlerts();
  if (state.view === 'triggers') return renderTriggers();
  if (state.view === 'hosts') return renderHosts();
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
  let targets, hosts;
  try { [targets, hosts] = await Promise.all([api('/api/targets'), api('/api/hosts')]); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  const hmap = {};
  for (const h of hosts) hmap[h.host_key] = h;
  main.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="addTarget">+ 新建监控目标</button>
      <div class="spacer"></div>
      <span class="hint">支持 摄像机/交换机/防火墙/控制器/Linux/数据库/网络链路/应用, 无需安装Agent</span>
    </div>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table><thead><tr><th>名称</th><th>类型</th><th>地址</th><th>探测方式</th><th>间隔</th><th>状态</th><th>最近错误</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>${targets.map(t => {
        const h = hmap['probe:' + t.id];
        const st = h ? probeStatus(h) : { ok: true };
        return `<tr>
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
      }).join('') || '<tr><td colspan="9" class="empty">暂无监控目标, 点击"新建监控目标"添加</td></tr>'}</tbody></table>
    </div>`;
  $('#addTarget').onclick = () => probeForm(null);
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
    confirmModal(`删除监控目标「${esc(t.name)}」?`, '其历史数据与告警将一并删除。', async () => {
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
    ctx.fillStyle = '#8493b8';
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
    ctx.strokeStyle = '#26314f';
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillStyle = '#8493b8';
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
    ctx.fillStyle = '#8493b8';
    ctx.fillText(lab, x(ts), H - pad.b + 8);
  }

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(79,140,255,.35)');
  grad.addColorStop(1, 'rgba(79,140,255,.02)');
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(x(p.ts), y(p.value)) : ctx.moveTo(x(p.ts), y(p.value)));
  ctx.strokeStyle = '#4f8cff';
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
  ctx.fillStyle = '#4f8cff';
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
  ctx.strokeStyle = 'rgba(217,225,245,.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(c.x(best.ts), c.pad.t); ctx.lineTo(c.x(best.ts), c.H - c.pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(c.x(best.ts), c.y(best.value), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
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

/* ---------- 主机管理 ---------- */

async function renderHosts() {
  let hosts, stats, targets;
  try { [hosts, stats, targets] = await Promise.all([api('/api/hosts'), api('/api/stats'), api('/api/targets')]); }
  catch (e) { main.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`; return; }
  state.hosts = hosts;
  const tmap = {};
  for (const t of targets) tmap['probe:' + t.id] = t;
  const origin = location.origin;
  main.innerHTML = `
    <div class="panel" style="padding:0;overflow-x:auto">
      <table><thead><tr><th>名称</th><th>类型</th><th>主机标识</th><th>IP</th><th>系统/设备</th><th>最后上报</th><th>状态</th><th>告警</th><th>操作</th></tr></thead>
      <tbody>${hosts.map(h => `<tr>
        <td><b>${esc(h.name)}</b></td>
        <td>${h.kind === 'probe' ? esc(DEVICE_TYPE_NAMES[h.dtype] || '设备') : 'Agent主机'}</td>
        <td>${esc(h.host_key)}</td>
        <td>${esc(h.ip || '-')}</td>
        <td>${esc(h.kind === 'probe' ? (DEVICE_TYPE_NAMES[h.dtype] || '-') : (h.os || '-'))}</td>
        <td style="white-space:nowrap">${fmtAgo(h.last_seen)}</td>
        <td><span class="dot ${h.online ? 'on' : 'off'}"></span> ${h.online ? '在线' : '离线'}</td>
        <td>${h.alerts > 0 ? `<span class="badge">${h.alerts}</span>` : '-'}</td>
        <td style="white-space:nowrap">
          <button class="btn ghost sm" data-detail="${h.id}">详情</button>
          ${h.kind === 'probe' ? `<button class="btn ghost sm" data-cfg="${h.id}">配置</button>` : `<button class="btn ghost sm" data-rename="${h.id}">重命名</button>`}
          <button class="btn danger sm" data-del="${h.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">暂无主机</td></tr>'}</tbody></table>
    </div>
    <div class="panel">
      <h2>接入新主机 (Agent 部署)</h2>
      <div class="hint">
        ${stats.agent_package ? '<a href="/download/agent-package.zip" download>下载 Agent 部署包 (agent-package.zip, 含运行时)</a><br>' : '提示: 在服务端目录运行 make-agent.bat 可生成 agent-package.zip 部署包<br>'}
        1. 将 <b>agent-package.zip</b> 复制到目标 Windows 电脑并解压 (无需安装任何环境);<br>
        2. 修改解压目录中 <b>config.json</b> 的 agent.server_url 为服务端地址, 例如:
        <div class="code">"agent": { "server_url": "${esc(origin.replace('127.0.0.1', '服务端局域网IP'))}" }</div>
        3. 双击 <b>agent.bat</b> 启动, 主机将自动注册并开始上报数据。<br>
        注: 若服务端 config.json 中设置了 token, Agent 端需填写相同的 token。
      </div>
    </div>`;
  main.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => openHost(Number(b.dataset.detail)));
  main.querySelectorAll('[data-cfg]').forEach(b => b.onclick = () => {
    const h = hosts.find(x => x.id === Number(b.dataset.cfg));
    probeForm(tmap[h.host_key]);
  });
  main.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
    const h = hosts.find(x => x.id === Number(b.dataset.rename));
    openModal(`
      <h3>重命名主机</h3>
      <div class="form-row"><label>显示名称</label><input type="text" id="fName" value="${esc(h.name)}"></div>
      <div class="form-actions"><button class="btn ghost" id="fCancel">取消</button><button class="btn" id="fSave">保存</button></div>`);
    $('#fCancel').onclick = closeModal;
    $('#fSave').onclick = async () => {
      const name = $('#fName').value.trim();
      if (!name) return toast('名称不能为空', true);
      try {
        await api('/api/host?id=' + h.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        toast('已保存'); closeModal(); renderHosts();
      } catch (e) { toast(e.message, true); }
    };
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const h = hosts.find(x => x.id === Number(b.dataset.del));
    confirmModal(`删除主机「${esc(h.name)}」?`, '该主机的所有历史数据和告警将被删除, Agent 再次上报时会重新注册。', async () => {
      await api('/api/host?id=' + h.id, { method: 'DELETE' });
      toast('已删除');
      renderHosts();
    });
  });
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

function confirmModal(title, desc, onOk) {
  openModal(`
    <h3>${title}</h3>
    <div class="hint">${desc}</div>
    <div class="form-actions"><button class="btn ghost" id="cCancel">取消</button><button class="btn danger" id="cOk">确认删除</button></div>`);
  $('#cCancel').onclick = closeModal;
  $('#cOk').onclick = async () => {
    try { await onOk(); closeModal(); }
    catch (e) { toast(e.message, true); }
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

async function pollStatus() {
  const el = $('#serverStatus');
  try {
    const s = await api('/api/stats');
    el.innerHTML = `<span class="dot"></span>运行中 · v${esc(s.version)} · 已运行 ${fmtDuration(s.uptime)}`;
  } catch {
    el.innerHTML = `<span class="dot" style="background:var(--red)"></span>连接失败`;
  }
}

setInterval(() => {
  if (state.modalOpen) return;
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