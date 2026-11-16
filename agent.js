'use strict';
const fs = require('fs');
const path = require('path');
const metrics = require('./lib/metrics');
const httpc = require('./lib/httpc');
const paths = require('./lib/paths');

const CONFIG_FILE = paths.CONFIG_FILE;
const PID_FILE = paths.AGENT_PID_FILE;
const STATE_FILE = path.join(paths.DATA_DIR, 'agent-state.json');

const DEFAULT_AGENT = { server_url: 'http://127.0.0.1:8686', token: '', interval_sec: 15, hostname: '', name: '' };

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('config.json 解析失败, 使用默认配置:', e.message); }
  } else {
    paths.writeQuiet(CONFIG_FILE, JSON.stringify({ agent: DEFAULT_AGENT }, null, 2));
  }
  return { ...DEFAULT_AGENT, ...cfg.agent };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function readPid() {
  try { return Number(String(fs.readFileSync(PID_FILE, 'utf8')).trim()) || 0; } catch (e) { return 0; }
}

function alivePid(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// 后台启动脚本用它确认 Agent 真的在上报, 而不是只看进程有没有起来。
if (process.argv[2] === '--status') {
  const cfg = loadConfig();
  const st = readState();
  const pid = st && st.pid ? st.pid : readPid();
  if (!alivePid(pid)) { console.log('STOPPED Agent 未在运行'); process.exit(1); }
  if (!st || !st.ts) { console.log('STARTING PID=' + pid + ' 尚未完成首次上报'); process.exit(1); }
  const age = Math.floor((Date.now() - st.ts) / 1000);
  const limit = Math.max(30, cfg.interval_sec * 3);
  if (!st.ok) { console.log('FAIL PID=' + pid + ' 上报失败: ' + (st.error || '未知错误')); process.exit(1); }
  if (age > limit) { console.log('STALE PID=' + pid + ' 已 ' + age + ' 秒没有成功上报'); process.exit(1); }
  console.log('OK PID=' + pid + ' ' + age + ' 秒前上报成功 名称=' + (st.name || ''));
  process.exit(0);
}

if (process.argv[2] === '--stop') {
  const st = readState();
  const pid = st && st.pid ? st.pid : readPid();
  if (!alivePid(pid)) {
    console.log('Agent 未在运行。');
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    try { fs.unlinkSync(STATE_FILE); } catch (e) {}
    process.exit(0);
  }
  try {
    // Windows 上 Node 的 process.kill 直接结束进程, 子进程的信号处理器不会执行,
    // 所以 pid / state 文件由这里清理。
    process.kill(pid, 'SIGTERM');
    console.log('已停止 Agent (PID=' + pid + ')。');
  } catch (e) {
    console.error('停止失败 (PID=' + pid + '): ' + e.message);
    process.exit(1);
  }
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
  process.exit(0);
}

require('./lib/log')(paths.AGENT_LOG_FILE);

const cfg = loadConfig();
const intervalMs = Math.max(5, cfg.interval_sec) * 1000;
const slowMs = Math.max(30, cfg.interval_sec * 2) * 1000;
const pushUrl = cfg.server_url.replace(/\/+$/, '') + '/api/push';

// 重复双击启动脚本会跑出两个 Agent 抢同一个主机标识, 数据互相覆盖。
const prev = readState();
const prevPid = prev && prev.pid ? prev.pid : readPid();
if (alivePid(prevPid)) {
  console.error('Agent 已在运行 (PID=' + prevPid + '), 本次启动取消。');
  console.error('要重启请先运行 agent-stop.bat 停止, 再重新启动。');
  process.exit(3);
}

const info = metrics.hostInfo();
if (cfg.hostname) info.key = cfg.hostname;
if (cfg.name) info.name = cfg.name;

paths.writeQuiet(PID_FILE, String(process.pid));
if (paths.redirected) console.log('[路径] 程序目录不可写, 数据目录: ' + paths.DATA_DIR);

let failures = 0;
let running = false;

function writeState(ok, error) {
  paths.writeQuiet(STATE_FILE, JSON.stringify({
    pid: process.pid, ts: Date.now(), ok, error: error || '',
    url: pushUrl, key: info.key, name: info.name, failures,
  }));
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const m = await metrics.collect(slowMs);
    const resp = await httpc.request(pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...info, metrics: m, token: cfg.token }),
      timeout: 10000,
    });
    if (!resp.ok) throw new Error(`服务端返回 ${resp.status}: ${resp.text()}`);
    failures = 0;
    writeState(true, '');
    console.log(`上报成功 CPU=${m['cpu.util']}% 内存=${m['mem.used_pct']}%`);
  } catch (e) {
    failures++;
    writeState(false, e.message);
    console.error(`上报失败(第${failures}次): ${e.message}`);
  } finally {
    running = false;
  }
}

console.log('======================================================');
console.log('  WinMon Agent 已启动');
console.log(`  主机标识: ${info.key}  名称: ${info.name}`);
console.log(`  上报地址: ${pushUrl}`);
console.log(`  采集间隔: ${intervalMs / 1000} 秒`);
console.log(`  日志文件: ${paths.AGENT_LOG_FILE}`);
console.log('  前台运行时按 Ctrl+C 停止; 后台运行请用 agent-stop.bat');
console.log('======================================================');

tick();
setInterval(tick, intervalMs);

function shutdown() {
  console.log('Agent 已停止');
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(STATE_FILE); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);