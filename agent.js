'use strict';
const fs = require('fs');
const path = require('path');
const metrics = require('./lib/metrics');
const httpc = require('./lib/httpc');
const paths = require('./lib/paths');

const ROOT = paths.ROOT;
const CONFIG_FILE = paths.CONFIG_FILE;

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

const cfg = loadConfig();
const intervalMs = Math.max(5, cfg.interval_sec) * 1000;
const slowMs = Math.max(30, cfg.interval_sec * 2) * 1000;
const pushUrl = cfg.server_url.replace(/\/+$/, '') + '/api/push';

const info = metrics.hostInfo();
if (cfg.hostname) info.key = cfg.hostname;
if (cfg.name) info.name = cfg.name;

const PID_FILE = path.join(paths.DATA_DIR, 'agent.pid');
paths.writeQuiet(PID_FILE, String(process.pid));
if (paths.redirected) console.log('[路径] 程序目录不可写, 数据目录: ' + paths.DATA_DIR);

let failures = 0;
let running = false;

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
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 上报成功 CPU=${m['cpu.util']}% 内存=${m['mem.used_pct']}%`);
  } catch (e) {
    failures++;
    console.error(`[${new Date().toLocaleTimeString('zh-CN')}] 上报失败(第${failures}次): ${e.message}`);
  } finally {
    running = false;
  }
}

console.log('======================================================');
console.log('  WinMon Agent 已启动');
console.log(`  主机标识: ${info.key}  名称: ${info.name}`);
console.log(`  上报地址: ${pushUrl}`);
console.log(`  采集间隔: ${intervalMs / 1000} 秒, 按 Ctrl+C 停止`);
console.log('======================================================');

tick();
setInterval(tick, intervalMs);

function shutdown() {
  console.log('\nAgent 已停止');
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);