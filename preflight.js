'use strict';
// WinMon startup preflight / diagnostics.
// Runs BEFORE the server is launched hidden, so a failure on Windows 7 is
// visible instead of silently producing no window at all.
// Console output is ASCII-only on purpose: Windows 7's console defaults to a
// raster font and a legacy codepage, where UTF-8 Chinese renders as garbage.
// The full Chinese report is written as UTF-8 with BOM so Notepad reads it.
//   preflight.js --quick    fast checks, used by start.bat
//   preflight.js --full     adds PowerShell / collect.ps1 / ping / disk checks
//   preflight.js --wait=25  poll /api/health until the service answers
//   preflight.js --url      print the web UI address only
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');
const paths = require('./lib/paths');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const QUICK = argv.includes('--quick');
const URL_ONLY = argv.includes('--url');
const WAIT = (argv.find(a => a.indexOf('--wait=') === 0) || '').split('=')[1];

const isWin = process.platform === 'win32';
const rel = os.release();
const dataDir = paths.DATA_DIR;
const results = [];
let failed = 0;
let warned = 0;
let csd = '';

let cfg = { server: { port: 8686, host: '0.0.0.0' } };
let configError = null;
try {
  if (fs.existsSync(paths.CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(paths.CONFIG_FILE, 'utf8'));
} catch (e) { configError = e.message; }
const port = Number((cfg.server && cfg.server.port) || 8686);
const url = 'http://127.0.0.1:' + port;

function rec(level, name, detail, hint) {
  results.push({ level, name, detail, hint: hint || '' });
  if (level === 'FAIL') failed++;
  if (level === 'WARN') warned++;
  const tag = level === 'OK' ? '[ OK ]' : level === 'WARN' ? '[WARN]' : '[FAIL]';
  console.log(tag + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (level !== 'OK' && hint) console.log('       -> ' + hint);
}
function ascii(s) { return String(s).replace(/[^\x20-\x7e]/g, '?'); }
function run(cmd, args, timeout) {
  return execFileSync(cmd, args, { timeout: timeout || 15000, encoding: 'buffer', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function health(timeout) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeout || 1500 }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(b));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
function portFree() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', e => resolve(e.code));
    srv.once('listening', () => srv.close(() => resolve(null)));
    srv.listen(port, (cfg.server && cfg.server.host) || '0.0.0.0');
  });
}

// ---------- runtime / OS ----------
function checkRuntime() {
  rec('OK', 'Node runtime', process.version + ' ' + process.arch + ' (' + ascii(process.execPath) + ')');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 12) rec('FAIL', 'Node version too old', process.version, 'Use the bundled runtime/node.exe (Node 12.22.12).');
  else if (major > 12) rec('WARN', 'Node newer than bundled', process.version, 'Node 14+ does not run on Windows 7. Use runtime\\node.exe.');

  const p = rel.split('.').map(Number);
  rec('OK', 'Operating system', os.type() + ' ' + rel + ' ' + os.arch() + ' host=' + ascii(os.hostname()));
  if (isWin && p[0] === 6 && p[1] === 0) rec('FAIL', 'Windows Vista is not supported', rel, 'Windows 7 SP1 or newer is required.');

  if (isWin) {
    for (const v of ['CSDVersion', 'ProductName']) {
      try {
        const out = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', v]);
        const m = out.toString('latin1').match(new RegExp(v + '\\s+REG_SZ\\s+(.+)'));
        if (!m) continue;
        if (v === 'CSDVersion') csd = m[1].trim();
        else rec('OK', 'Windows edition', ascii(m[1].trim()) + (csd ? ' / ' + ascii(csd) : ''));
      } catch (e) { /* value absent on Win8+ */ }
    }
    if (p[0] === 6 && p[1] === 1 && !/Service Pack 1/i.test(csd)) {
      rec('WARN', 'Windows 7 without SP1 detected', csd || 'CSDVersion not present',
        'Install Windows 7 Service Pack 1. Node 12 is only supported on SP1.');
    }
    for (const f of ['runtime/node.exe', 'runtime/node-x86.exe']) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) {
        if (f === 'runtime/node.exe') rec('FAIL', 'Missing ' + f, '', 'Re-extract winmon-server-windows.zip; the runtime folder must be present.');
        else rec('WARN', 'Missing ' + f, '', '32-bit Windows will not be able to start. Re-extract the full zip.');
        continue;
      }
      const size = fs.statSync(full).size;
      if (size < 10 * 1024 * 1024) rec('FAIL', f + ' looks truncated', size + ' bytes', 'The download or extraction was incomplete. Re-download the release zip.');
      else rec('OK', f, (size / 1048576).toFixed(1) + ' MB');
    }
    if (os.arch() !== process.arch && !(os.arch() === 'x64' && process.arch === 'ia32')) {
      rec('FAIL', 'Runtime architecture mismatch', 'OS=' + os.arch() + ' runtime=' + process.arch,
        'A 64-bit runtime cannot run on 32-bit Windows. pick-node.bat should select runtime\\node-x86.exe.');
    }
  }
}

// ---------- files / permissions / modules / storage ----------
const REQUIRED = ['server.js', 'agent.js', 'config.json',
  'lib/paths.js', 'lib/log.js', 'lib/db.js', 'lib/store.js', 'lib/metrics.js', 'lib/alert.js', 'lib/probe.js',
  'lib/mailer.js', 'lib/httpc.js', 'lib/snmp.js', 'lib/dbcheck.js', 'lib/collect.ps1',
  'public/index.html', 'public/app.js', 'public/compat.js', 'public/style.css'];

function checkInstall() {
  const missing = REQUIRED.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) rec('FAIL', 'Missing application files', ascii(missing.join(', ')), 'Extract ALL files from the zip, keeping the folder structure.');
  else rec('OK', 'Application files', REQUIRED.length + ' required files present');

  if (paths.error && !paths.redirected) {
    rec('FAIL', 'No writable data directory', paths.error + ' (' + ascii(dataDir) + ')',
      'Move the WinMon folder out of "Program Files" / the drive root, e.g. to D:\\WinMon, or run as administrator.');
  } else if (paths.redirected) {
    rec('WARN', 'Application folder is read-only', paths.error + ', data stored in ' + ascii(dataDir),
      'This happens when extracted into "Program Files" or C:\\ root. Data is redirected automatically; moving the folder to D:\\WinMon is cleaner.');
  } else {
    rec('OK', 'Data directory writable', ascii(dataDir));
  }
  if (!paths.rootWritable) rec('WARN', 'Config redirected', 'config.json will be saved to ' + ascii(paths.CONFIG_FILE), 'Move the folder to a writable location such as D:\\WinMon.');
  else rec('OK', 'Application folder writable', 'config: ' + ascii(paths.CONFIG_FILE));

  const libs = ['paths', 'store', 'sqlite-import', 'db', 'metrics', 'httpc', 'alert', 'mailer', 'probe', 'snmp', 'dbcheck', 'mkzip'];
  const errs = [];
  for (const l of libs) {
    try { require(path.join(ROOT, 'lib', l + '.js')); }
    catch (e) { errs.push(l + ': ' + e.message); }
  }
  if (errs.length) rec('FAIL', 'Module load errors', ascii(errs.join(' | ')), 'The installation is damaged or the Node runtime is too old.');
  else rec('OK', 'All modules load', libs.length + ' modules');

  try {
    const { Series, rimraf } = require(path.join(ROOT, 'lib', 'store.js'));
    const t = path.join(dataDir, '.preflight-series');
    rimraf(t);
    const s = new Series(t);
    const now = Date.now();
    s.append(999999, { 'cpu.util': 12.5, 'disk.used_pct[C:]': 40 }, now - 1000);
    s.append(999999, { 'cpu.util': 13.5, 'disk.used_pct[C:]': 41 }, now);
    const got = s.range(999999, 'cpu.util', now - 5000, now + 1000, 0);
    rimraf(t);
    if (got.length !== 2) throw new Error('expected 2 points, got ' + got.length);
    rec('OK', 'Storage engine read/write', 'binary series round-trip OK');
  } catch (e) {
    rec('FAIL', 'Storage engine failed', ascii(e.message), 'Check antivirus / folder permissions on the data directory.');
  }

  // 全新安装时 seedTriggers / seedProbeTriggers 必须能跑通, 否则服务启动即崩。
  try {
    const DB = require(path.join(ROOT, 'lib', 'db.js'));
    const t = path.join(dataDir, '.preflight-db');
    require(path.join(ROOT, 'lib', 'store.js')).rimraf(t);
    const db = new DB(path.join(t, 'monitor.db'));
    db.seedTriggers();
    db.seedProbeTriggers();
    const n = db.getTriggers().length;
    db.close();
    require(path.join(ROOT, 'lib', 'store.js')).rimraf(t);
    if (n < 9) throw new Error('expected 9 default triggers, got ' + n);
    rec('OK', 'Fresh database seeding', n + ' default triggers created');
  } catch (e) {
    rec('FAIL', 'Fresh database seeding', ascii(e.message), 'A fresh install would fail to start. Re-extract the release zip.');
  }

  if (configError) rec('FAIL', 'config.json is invalid JSON', ascii(configError), 'Delete config.json to regenerate defaults, or fix the syntax.');
  else rec('OK', 'config.json parsed', 'port=' + port);
}

// ---------- external tools (slow, full mode only) ----------
function checkTools() {
  if (!isWin) return;
  try {
    const out = run('where', ['ping.exe']);
    rec('OK', 'ping.exe found', ascii(out.toString('latin1').trim().split(/\r?\n/)[0]));
  } catch (e) {
    rec('WARN', 'ping.exe not found in PATH', '', 'Ping probes will fail. Check the system PATH.');
  }
  let psVer = null;
  try {
    psVer = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], 25000).toString('latin1').trim();
    rec('OK', 'PowerShell version', psVer);
  } catch (e) {
    rec('WARN', 'PowerShell not available', ascii(e.message).slice(0, 120),
      'Disk / network / process metrics will be unavailable. Install Windows Management Framework (PowerShell).');
  }
  if (psVer) {
    try {
      const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'lib', 'collect.ps1')], 40000);
      const j = JSON.parse(out.toString('utf8').trim());
      rec('OK', 'collect.ps1 executed', 'disks=' + (j.disks || []).length + ' net=' + (j.net || []).length + ' procs=' + j.procs +
        (Number(psVer.split('.')[0]) < 3 ? ' (PowerShell 2.0 WMI fallback)' : ' (CIM)'));
    } catch (e) {
      rec('WARN', 'collect.ps1 failed', ascii(e.message).slice(0, 160),
        'Slow metrics (disk / network / memory) will be missing. Try: powershell -ExecutionPolicy Bypass -File lib\\collect.ps1');
    }
  }
  try {
    const probe = require(path.join(ROOT, 'lib', 'probe.js'));
    const buf = run('ping', ['-n', '1', '-w', '1000', '127.0.0.1'], 12000);
    const r = probe.parsePing(buf, 1);
    rec(r.ok ? 'OK' : 'WARN', 'ping loopback',
      r.ok ? 'latency=' + r.latency + 'ms loss=' + r.loss + '% (raw bytes, GBK-safe)' : 'no reply',
      r.ok ? '' : 'Ping probes may not work on this machine.');
  } catch (e) {
    rec('WARN', 'ping loopback failed', ascii(e.message).slice(0, 120), '');
  }
}

function checkZone() {
  if (!isWin) return;
  const blocked = [];
  for (const f of ['start.bat', 'stop.bat', 'pick-node.bat', 'runtime/node.exe']) {
    try { fs.readFileSync(path.join(ROOT, f) + ':Zone.Identifier', 'utf8'); blocked.push(f); }
    catch (e) { /* not blocked */ }
  }
  if (blocked.length) rec('WARN', 'Files carry a download mark', ascii(blocked.join(', ')),
    'Right-click the zip -> Properties -> Unblock before extracting, or unblock these files. Windows may refuse to run them.');
}

function checkDisk() {
  try {
    // dir 的 "bytes free" 在中文系统上被本地化成「可用字节」, 不能按英文关键字匹配;
    // 两种语言的最后一行都是「目录数 + 可用字节数」, 取输出里最后一个数字即可。
    const out = run(isWin ? 'cmd' : 'df', isWin ? ['/c', 'dir', '/-C', dataDir] : ['-k', dataDir], 12000).toString('latin1');
    let free;
    if (isWin) {
      const nums = out.match(/\d[\d,]*/g);
      free = nums && nums.length ? Number(nums[nums.length - 1].replace(/,/g, '')) : NaN;
    } else {
      free = Number(out.trim().split(/\r?\n/).pop().trim().split(/\s+/)[3]) * 1024;
    }
    if (!isFinite(free) || free <= 0) return;
    if (free < 200 * 1024 * 1024) rec('WARN', 'Low disk space', (free / 1048576).toFixed(0) + ' MB free', 'History storage needs free space.');
    else rec('OK', 'Free disk space', (free / 1073741824).toFixed(1) + ' GB');
  } catch (e) { /* cosmetic check only */ }
}

const CN = {
  'Node runtime': 'Node 运行时', 'Node version too old': 'Node 版本过低', 'Node newer than bundled': 'Node 版本高于内置版本',
  'Operating system': '操作系统', 'Windows edition': 'Windows 版本', 'Windows Vista is not supported': '不支持 Windows Vista',
  'Windows 7 without SP1 detected': '检测到未安装 SP1 的 Windows 7', 'Runtime architecture mismatch': '运行时位数与系统不匹配',
  'Missing application files': '缺少程序文件', 'Application files': '程序文件完整性',
  'Data directory writable': '数据目录可写', 'No writable data directory': '没有可写的数据目录',
  'Application folder is read-only': '程序目录只读', 'Application folder writable': '程序目录可写',
  'Config redirected': '配置文件改存到数据目录', 'All modules load': '全部模块加载', 'Module load errors': '模块加载失败',
  'Storage engine read/write': '存储引擎读写', 'Storage engine failed': '存储引擎故障',
  'Fresh database seeding': '全新数据库初始化', 'config.json parsed': 'config.json 解析',
  'config.json is invalid JSON': 'config.json 格式错误',
  'Port is free': '端口可用', 'Port already in use': '端口被占用', 'WinMon already running': 'WinMon 已在运行',
  'ping.exe found': '找到 ping.exe', 'ping.exe not found in PATH': 'PATH 中找不到 ping.exe',
  'PowerShell version': 'PowerShell 版本', 'PowerShell not available': 'PowerShell 不可用',
  'collect.ps1 executed': '采集脚本执行', 'collect.ps1 failed': '采集脚本失败',
  'ping loopback': 'Ping 回环测试', 'ping loopback failed': 'Ping 回环失败',
  'Files carry a download mark': '文件带有下载锁定标记', 'Free disk space': '磁盘可用空间', 'Low disk space': '磁盘空间不足',
};
const HINT = {
  'Windows 7 without SP1 detected': '请安装 Windows 7 Service Pack 1，Node 12 仅支持 SP1 及以上。',
  'Runtime architecture mismatch': '64 位运行时无法在 32 位 Windows 上运行，应由 pick-node.bat 选择 runtime\\node-x86.exe。',
  'No writable data directory': '请把 WinMon 目录从「Program Files」或磁盘根目录移动到例如 D:\\WinMon，或以管理员身份运行。',
  'Application folder is read-only': '通常是解压到了「Program Files」或 C 盘根目录。数据会自动改存到用户目录，建议把整个目录移到 D:\\WinMon。',
  'Config redirected': '程序目录不可写，配置改存到数据目录；建议把整个目录移到 D:\\WinMon。',
  'Missing application files': '请完整解压 zip，保持目录结构，不要只复制部分文件。',
  'Module load errors': '安装文件损坏或运行时版本过低，请重新解压发布包。',
  'Storage engine failed': '请检查杀毒软件拦截与数据目录权限。',
  'Fresh database seeding': '全新安装会在启动时崩溃，请重新解压发布包或换用最新版本。',
  'Port already in use': '请修改 config.json 中的 server.port，或停止占用该端口的程序。',
  'PowerShell not available': '磁盘/网络/进程指标将不可用，请安装 Windows Management Framework。',
  'collect.ps1 failed': '慢速指标（磁盘/网络/内存）会缺失。可手动执行 powershell -ExecutionPolicy Bypass -File lib\\collect.ps1 查看报错。',
  'Files carry a download mark': '请右键 zip → 属性 → 解除锁定后再解压，否则 Windows 可能拒绝运行。',
  'Node version too old': '请使用内置的 runtime\\node.exe（Node 12.22.12）。',
};

function cnName(n) {
  if (CN[n]) return CN[n];
  let m = n.match(/^Missing (.+)$/);
  if (m) return '缺少文件 ' + m[1];
  m = n.match(/^(.+) looks truncated$/);
  if (m) return m[1] + ' 文件不完整';
  return n;
}
function cnHint(r) {
  if (HINT[r.name]) return HINT[r.name];
  if (/^Missing runtime/.test(r.name)) return '请重新完整解压发布包; 32 位 Windows 需要 runtime\\node-x86.exe。';
  if (/looks truncated$/.test(r.name)) return '下载或解压不完整, 请重新下载发布包并完整解压。';
  return r.hint;
}

function writeReport(extra) {
  const L = [];
  L.push('WinMon 启动诊断报告');
  L.push('生成时间: ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  let version = '?';
  try { version = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1]; } catch (e) { }
  L.push('版本: ' + version);
  L.push('');
  L.push('结论: ' + (failed ? '发现 ' + failed + ' 个阻断问题, ' + warned + ' 个警告'
    : warned ? '可以启动, 但有 ' + warned + ' 个警告' : '全部检查通过, 可以启动'));
  L.push('');
  for (const r of results) {
    const mark = r.level === 'OK' ? '正常' : r.level === 'WARN' ? '警告' : '失败';
    L.push('[' + mark + '] ' + cnName(r.name) + (r.detail ? ' —— ' + r.detail : ''));
    if (r.level !== 'OK') L.push('        建议: ' + cnHint(r));
  }
  if (extra && extra.length) { L.push(''); L.push('—— 详细信息 ——'); for (const e of extra) L.push(e); }
  L.push('');
  L.push('—— 环境 ——');
  L.push('程序目录: ' + ROOT);
  L.push('数据目录: ' + dataDir);
  L.push('配置文件: ' + paths.CONFIG_FILE);
  L.push('Node: ' + process.version + ' ' + process.arch + ' (' + process.execPath + ')');
  L.push('系统: ' + os.type() + ' ' + rel + ' ' + os.arch() + (csd ? ' ' + csd : ''));
  L.push('CPU 逻辑核心: ' + os.cpus().length + '  内存: ' + (os.totalmem() / 1073741824).toFixed(1) + ' GB');
  L.push('访问地址: ' + url);
  L.push('');
  L.push('—— Windows 7 双击没反应时的排查顺序 ——');
  L.push('1. 双击 diagnose.bat 生成本报告; 若连报告都没有, 说明 Node 运行时没能启动。');
  L.push('2. 双击 start-console.bat 以前台方式运行, 错误会直接留在窗口里。');
  L.push('3. 确认系统是 Windows 7 SP1(32 位系统需要 runtime\\node-x86.exe)。');
  L.push('4. 把整个目录从「Program Files」或 C 盘根目录移到 D:\\WinMon 这类可写位置。');
  L.push('5. 右键 zip → 属性 → 解除锁定, 再重新解压; 检查杀毒软件是否拦截了 node.exe。');
  L.push('6. 界面打不开但服务在跑: Win7 自带的 IE11 无法运行本界面,');
  L.push('   请安装 Chrome 109.0.5414.120 或 Firefox 115 ESR, 或用局域网内其它设备访问。');

  let p = path.join(dataDir, 'diagnose.txt');
  try { fs.mkdirSync(dataDir, { recursive: true }); }
  catch (e) { p = path.join(os.tmpdir(), 'winmon-diagnose.txt'); }
  try { fs.writeFileSync(p, '\ufeff' + L.join('\r\n'), 'utf8'); }
  catch (e) { p = path.join(os.tmpdir(), 'winmon-diagnose.txt'); fs.writeFileSync(p, '\ufeff' + L.join('\r\n'), 'utf8'); }
  return p;
}

function collectExtra() {
  const extra = [];
  const legacy = path.join(ROOT, 'data', 'monitor.db');
  try {
    if (fs.existsSync(legacy)) {
      const d = require(path.join(ROOT, 'lib', 'sqlite-import.js')).readSqlite(legacy);
      extra.push('旧数据库 monitor.db 可解析: ' + Object.keys(d.tables).map(k => k + '=' + d.tables[k].rows.length).join(', '));
    }
  } catch (e) { extra.push('旧数据库解析失败: ' + e.message); }
  try {
    const sf = path.join(dataDir, 'store.json');
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
      extra.push('当前 store.json: 主机=' + s.hosts.length + ' 设备=' + s.targets.length + ' 触发器=' + s.triggers.length + ' 告警=' + s.alerts.length);
    }
  } catch (e) { extra.push('store.json 读取失败: ' + e.message); }
  try {
    const log = paths.LOG_FILE;
    if (fs.existsSync(log)) {
      extra.push('server.log 末尾 30 行:');
      for (const l of fs.readFileSync(log, 'utf8').split(/\r?\n/).slice(-30)) extra.push('  ' + l);
    }
  } catch (e) { }
  return extra;
}

async function waitReady() {
  const secs = Math.max(3, Number(WAIT) || 20);
  const deadline = Date.now() + secs * 1000;
  process.stdout.write('Waiting for the service to come up');
  while (Date.now() < deadline) {
    const h = await health(1500);
    if (h) {
      let v = '';
      try { v = JSON.parse(h).version; } catch (e) { }
      console.log(' OK');
      console.log('WinMon ' + v + ' is running at ' + url);
      return 0;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 700));
  }
  console.log(' TIMEOUT');
  console.log('No answer within ' + secs + 's. Log: ' + ascii(paths.LOG_FILE));
  return 1;
}

async function runChecks() {
  console.log('=== WinMon preflight (Node ' + process.version + ' ' + process.arch + ') ===');
  checkRuntime();
  checkInstall();
  checkZone();
  // 外部工具检查(PowerShell / collect.ps1 / ping)在 Win7 上可能要十几秒,
  // 正常启动路径跳过, 只在 diagnose.bat 或启动失败后的完整诊断里跑。
  if (!QUICK) { checkTools(); checkDisk(); }

  let alreadyRunning = false;
  const h = await health(1500);
  if (h) {
    let v = '';
    try { v = JSON.parse(h).version; } catch (e) { }
    alreadyRunning = true;
    rec('WARN', 'WinMon already running', 'version ' + v + ' on port ' + port,
      'A server is already listening. Open ' + url + ' instead of starting a second one.');
  } else {
    const err = await portFree();
    if (err) rec('FAIL', 'Port already in use', port + ' (' + err + ')', 'Change server.port in config.json, or stop the program using this port.');
    else rec('OK', 'Port is free', String(port));
  }

  const p = writeReport(FULL ? collectExtra() : []);
  console.log('');
  console.log('Report: ' + ascii(p));
  console.log(failed ? '=== PREFLIGHT FAILED: ' + failed + ' blocking issue(s) ==='
    : '=== PREFLIGHT PASSED' + (warned ? ' (' + warned + ' warning(s))' : '') + ' ===');
  return failed ? 1 : alreadyRunning ? 2 : 0;
}

(async () => {
  if (URL_ONLY) { console.log(url); process.exit(0); }
  process.exit(WAIT ? await waitReady() : await runChecks());
})().catch(e => {
  console.error('PREFLIGHT ERROR: ' + ascii(e && e.stack || e));
  process.exit(1);
});