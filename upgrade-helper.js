'use strict';
// 在线升级的接管进程, 由新版安装包自带的运行时执行:
//   等旧服务进程退出 -> 用 staging 覆盖程序目录 -> 拉起新服务。
// 覆盖分成"先写 *.upgnew, 再统一改名"两步: 第一步失败时旧文件一个都没动,
// 可以重启旧版把服务还回去; 第二步只是改名, 失败窗口很小。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const k = process.argv[i];
  if (k.indexOf('--') === 0) args[k.slice(2)] = process.argv[i + 1];
}
const STAGING = args.staging;
const TARGET = args.target;
const DATA = args.data;
const OLD_PID = Number(args.pid);
const TO = args.to || '?';
const LOG = path.join(DATA, 'upgrade-helper.log');
const BOM = String.fromCharCode(0xfeff);

function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg + '\n';
  try {
    if (!fs.existsSync(LOG) || fs.statSync(LOG).size === 0) fs.writeFileSync(LOG, BOM, 'utf8');
    fs.appendFileSync(LOG, line, 'utf8');
  } catch (e) {}
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function oldServerGone() {
  // pid 文件已指向别的进程, 说明旧进程已经退出、新进程也已接管。
  // 旧进程崩溃时 pid 文件会残留成旧值, 这时以进程是否存在为准。
  try {
    const cur = Number(fs.readFileSync(path.join(DATA, 'server.pid'), 'utf8').trim());
    if (cur && cur !== OLD_PID) return true;
  } catch (e) {}
  return !alive(OLD_PID);
}

function waitOldExit(done) {
  const t0 = Date.now();
  (function poll() {
    if (oldServerGone()) return done(true);
    if (Date.now() - t0 > 120000) return done(false);
    setTimeout(poll, 300);
  })();
}

function findRuntime(root) {
  for (const f of ['runtime/node.exe', 'runtime/node-x86.exe']) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function startServer() {
  const rt = findRuntime(TARGET);
  if (!rt) throw new Error('程序目录里找不到 runtime/node.exe');
  const child = spawn(rt, [path.join(TARGET, 'server.js')], {
    cwd: TARGET,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, { WINMON_RESTART_CHILD: '1' }),
  });
  child.unref();
  return child.pid;
}

// 列出要安装的文件; config.json 以程序目录现有的为准, 升级不能重置用户配置。
function plan(fromDir, toDir) {
  const list = [];
  const skipped = [];
  (function walk(rel) {
    for (const name of fs.readdirSync(path.join(fromDir, rel))) {
      const child = rel ? rel + '/' + name : name;
      const src = path.join(fromDir, child);
      if (fs.statSync(src).isDirectory()) {
        if (child === 'data') continue;
        walk(child);
        continue;
      }
      if (child === 'config.json' && fs.existsSync(path.join(toDir, 'config.json'))) { skipped.push(child); continue; }
      if (/\.(log|pid|upgnew)$/i.test(child)) continue;
      list.push(child);
    }
  })('');
  return { list, skipped };
}

function install() {
  const p = plan(STAGING, TARGET);
  const staged = [];
  for (const rel of p.list) {
    const dst = path.join(TARGET, rel);
    const tmp = dst + '.upgnew';
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(tmp, fs.readFileSync(path.join(STAGING, rel)));
      staged.push({ rel, dst, tmp });
    } catch (e) {
      for (const s of staged) { try { fs.unlinkSync(s.tmp); } catch (e2) {} }
      throw new Error('写入 ' + rel + ' 失败: ' + e.message);
    }
  }
  let done = 0;
  for (const s of staged) {
    try {
      fs.renameSync(s.tmp, s.dst);
      done++;
    } catch (e) {
      for (const rest of staged) { try { fs.unlinkSync(rest.tmp); } catch (e2) {} }
      throw new Error('替换 ' + s.rel + ' 失败(已替换 ' + done + ' 个): ' + e.message);
    }
  }
  return { count: done, skipped: p.skipped };
}

log('[升级] 接管进程启动, 目标 v' + TO + ', 等待旧进程 PID=' + OLD_PID + ' 退出');
waitOldExit(gone => {
  if (!gone) {
    log('[升级] 等待旧进程退出超时(120 秒), 未改动任何文件。请手动停止服务后重试。');
    process.exit(1);
  }
  log('[升级] 旧进程已退出, 开始覆盖程序目录');
  let result;
  try {
    result = install();
    log('[升级] 已覆盖 ' + result.count + ' 个文件' +
      (result.skipped.length ? ', 保留原有 ' + result.skipped.join(', ') : '') + ', 版本 v' + TO);
  } catch (e) {
    log('[升级] 失败: ' + e.message);
    try { log('[升级] 尝试用旧文件重新拉起服务'); startServer(); }
    catch (e2) { log('[升级] 旧版也未能拉起: ' + e2.message + ', 请手动双击 start.bat'); }
    process.exit(1);
  }
  try {
    log('[升级] 已拉起新服务进程 PID=' + startServer());
  } catch (e) {
    log('[升级] 拉起新服务失败: ' + e.message + ', 请手动双击 start.bat');
    process.exit(1);
  }
  setTimeout(() => process.exit(0), 1500);
});
