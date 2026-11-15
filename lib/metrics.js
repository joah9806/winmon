'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const PS_SCRIPT = path.join(__dirname, 'collect.ps1');
const NET_EXCLUDE = /isatap|teredo|loopback|pseudo|bluetooth|wan miniport|virtual|vmware|vethernet|hyper-v|filter|qos|miniport/i;

function cpuSnapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuSnapshot();
let slowCache = null;
let slowAt = 0;
let slowPending = null;

function cpuUtil() {
  const cur = cpuSnapshot();
  const dTotal = cur.total - lastCpu.total;
  const dIdle = cur.idle - lastCpu.idle;
  lastCpu = cur;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

function runPowerShell() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT],
      { timeout: 25000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout.trim())); }
        catch (e) { reject(new Error('采集脚本输出解析失败: ' + e.message)); }
      });
  });
}

function parseMeminfo(text) {
  const m = text.match(/MemAvailable:\s+(\d+)\s+kB/);
  return m ? parseInt(m[1], 10) : null;
}
function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (name === 'lo') continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
}
let lastNet = null;

// fs.statfsSync 仅 Node 18.15+ 提供; Node 12 上改用 df 输出。
function dfTable() {
  const map = new Map();
  try {
    const out = execFileSync('df', ['-k', '-P'], { timeout: 8000, encoding: 'utf8' });
    for (const line of out.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 6) continue;
      const blocks = Number(f[1]), avail = Number(f[3]);
      if (!isFinite(blocks) || !isFinite(avail)) continue;
      map.set(f.slice(5).join(' '), { Size: blocks * 1024, FreeSpace: avail * 1024 });
    }
  } catch (e) {}
  return map;
}

function linuxSlow() {
  const out = { disks: [], net: [], os: {}, procs: 0 };
  try {
    const availKb = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (availKb != null) out.os.FreePhysicalMemory = availKb;
  } catch {}
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    const seen = new Set();
    const hasStatfs = typeof fs.statfsSync === 'function';
    const df = hasStatfs ? null : dfTable();
    for (const line of mounts) {
      const [dev, mp, fstype] = line.split(/\s+/);
      if (!dev || !mp || seen.has(dev)) continue;
      if (!/^(ext[234]|xfs|btrfs|zfs|ntfs|vfat|exfat|overlay|tmpfs)$/.test(fstype)) continue;
      if (mp.startsWith('/proc') || mp.startsWith('/sys') || mp.startsWith('/dev')) continue;
      seen.add(dev);
      if (hasStatfs) {
        try {
          const st = fs.statfsSync(mp);
          out.disks.push({ DeviceID: mp, Size: st.blocks * st.bsize, FreeSpace: st.bfree * st.bsize });
        } catch (e) {}
      } else {
        const d = df.get(mp);
        if (d) out.disks.push({ DeviceID: mp, Size: d.Size, FreeSpace: d.FreeSpace });
      }
    }
  } catch {}
  try {
    const cur = parseNetDev(fs.readFileSync('/proc/net/dev', 'utf8'));
    const now = Date.now();
    if (lastNet) {
      const dt = (now - lastNet.ts) / 1000;
      if (dt > 0) out.net.push({ Name: 'total', BytesReceivedPersec: Math.max(0, (cur.rx - lastNet.rx) / dt), BytesSentPersec: Math.max(0, (cur.tx - lastNet.tx) / dt) });
    }
    lastNet = { ...cur, ts: now };
  } catch {}
  try { out.procs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).length; } catch {}
  return out;
}

async function getSlow(slowIntervalMs) {
  const now = Date.now();
  if (slowCache && now - slowAt < slowIntervalMs) return slowCache;
  if (!slowPending) {
    slowPending = (IS_WIN ? runPowerShell() : Promise.resolve(linuxSlow()))
      .then(data => { slowCache = data; slowAt = Date.now(); return data; })
      .catch(() => slowCache)
      .finally(() => { slowPending = null; });
  }
  return slowPending;
}

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

function hostInfo() {
  const cpus = os.cpus();
  return {
    key: os.hostname(),
    name: os.hostname(),
    ip: localIp(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: cpus.length ? `${cpus[0].model.trim()} x${cpus.length}` : '',
  };
}

async function collect(slowIntervalMs = 30000) {
  const m = {};
  const total = os.totalmem();
  m['cpu.util'] = round(cpuUtil(), 2);
  m['mem.total'] = total;
  m['sys.uptime'] = Math.floor(os.uptime());

  const slow = await getSlow(slowIntervalMs);
  let avail = null;
  if (slow && slow.os && slow.os.FreePhysicalMemory != null) {
    avail = slow.os.FreePhysicalMemory * 1024;
  }
  if (avail == null) avail = os.freemem();
  const used = Math.max(0, total - avail);
  m['mem.available'] = avail;
  m['mem.used'] = used;
  m['mem.used_pct'] = round(used / total * 100, 2);

  if (slow && Array.isArray(slow.disks)) {
    for (const d of slow.disks) {
      if (!d.DeviceID || !d.Size) continue;
      const free = d.FreeSpace || 0;
      const usedPct = round((d.Size - free) / d.Size * 100, 2);
      m[`disk.used_pct[${d.DeviceID}]`] = usedPct;
      m[`disk.free[${d.DeviceID}]`] = free;
      m[`disk.total[${d.DeviceID}]`] = d.Size;
    }
  }
  if (slow && Array.isArray(slow.net)) {
    let inB = 0, outB = 0;
    for (const n of slow.net) {
      if (!n.Name || NET_EXCLUDE.test(n.Name)) continue;
      inB += n.BytesReceivedPersec || 0;
      outB += n.BytesSentPersec || 0;
    }
    m['net.in'] = inB;
    m['net.out'] = outB;
  }
  if (slow && typeof slow.procs === 'number') m['proc.count'] = slow.procs;
  return m;
}

function round(v, n) { const p = Math.pow(10, n); return Math.round(v * p) / p; }

const ITEM_META = {
  'cpu.util': { name: 'CPU使用率', unit: '%' },
  'mem.used_pct': { name: '内存使用率', unit: '%' },
  'mem.used': { name: '已用内存', unit: 'B' },
  'mem.available': { name: '可用内存', unit: 'B' },
  'mem.total': { name: '内存总量', unit: 'B' },
  'net.in': { name: '网络下载速率', unit: 'B/s' },
  'net.out': { name: '网络上传速率', unit: 'B/s' },
  'proc.count': { name: '进程数', unit: '' },
  'sys.uptime': { name: '运行时长', unit: 's' },
  'ping.ok': { name: 'Ping可达', unit: '' },
  'ping.latency': { name: 'Ping时延', unit: 'ms' },
  'ping.loss': { name: 'Ping丢包率', unit: '%' },
  'tcp.open': { name: '端口开放', unit: '' },
  'tcp.time': { name: '端口响应时间', unit: 'ms' },
  'http.ok': { name: 'HTTP正常', unit: '' },
  'http.status': { name: 'HTTP状态码', unit: '' },
  'http.time': { name: 'HTTP响应时间', unit: 'ms' },
  'db.ok': { name: '数据库连接', unit: '' },
  'db.time': { name: '数据库响应时间', unit: 'ms' },
  'snmp.up': { name: 'SNMP可达', unit: '' },
  'snmp.uptime': { name: '设备运行时长', unit: 's' },
  'snmp.in': { name: '接口入带宽', unit: 'B/s' },
  'snmp.out': { name: '接口出带宽', unit: 'B/s' },
  'snmp.ifup': { name: '接口状态', unit: '' },
  'snmp.cpu': { name: '设备CPU', unit: '%' },
};

function itemMeta(item) {
  if (ITEM_META[item]) return ITEM_META[item];
  const disk = item.match(/^disk\.(used_pct|free|total)\[(.+)\]$/);
  if (disk) {
    const names = { used_pct: '磁盘使用率', free: '磁盘剩余空间', total: '磁盘总空间' };
    return { name: `${names[disk[1]]}(${disk[2]})`, unit: disk[1] === 'used_pct' ? '%' : 'B' };
  }
  return { name: item, unit: '' };
}

module.exports = { collect, hostInfo, localIp, itemMeta, ITEM_META, _linux: { parseMeminfo, parseNetDev } };