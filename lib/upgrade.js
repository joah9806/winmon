'use strict';
// 在线升级: 校验收到的服务端安装包, 并把"替换文件 + 重启"交给新包自带的运行时去做。
// 旧进程退出后才能覆盖 runtime\node.exe, 所以接管进程必须跑在新包的运行时上,
// 这也是 helper 从 staging 而不是从程序目录启动的原因。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const unzip = require('./unzip');
const { rimraf, mkdirp } = require('./store');

const CORE = ['server.js', 'config.json', 'lib/db.js', 'lib/store.js', 'public/index.html', 'public/app.js'];
// 1.8.0 起安装包才带升级组件; 旧包版本号也会先被版本比较拦下。
const UPGRADE_PARTS = ['upgrade-helper.js', 'lib/upgrade.js', 'lib/unzip.js'];

function readVersion(root) {
  try {
    const m = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/const VERSION = '([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function parse(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function findRuntime(root) {
  for (const f of ['runtime/node.exe', 'runtime/node-x86.exe']) {
    if (fs.existsSync(path.join(root, f))) return path.join(root, f);
  }
  return null;
}

function upgradeDir(dataDir) { return path.join(dataDir, 'upgrade'); }

// 清掉上次升级的临时文件; 升级进程可能还没退出, 删不掉的留到下次。
function cleanup(dataDir) {
  const dir = upgradeDir(dataDir);
  if (!fs.existsSync(dir)) return false;
  rimraf(dir);
  return !fs.existsSync(dir);
}

// 解包并校验. 失败时清空 staging, 不留下半个可升级的目录。
// 校验顺序有意如此: 先确认是服务端包, 再比版本, 最后才要求升级组件,
// 否则上传旧版本包会得到"缺少 upgrade-helper"这种看不出原因的报错。
function stage(zipFile, dataDir, currentVersion) {
  const dir = upgradeDir(dataDir);
  const staging = path.join(dir, 'staging');
  try {
    rimraf(staging);
    mkdirp(staging);
    const files = unzip.extract(zipFile, staging, { maxTotal: 512 * 1024 * 1024 });
    const missing = CORE.filter(f => !fs.existsSync(path.join(staging, f)));
    if (missing.length) throw new Error('不是完整的服务端安装包, 缺少: ' + missing.join(', '));
    let version = readVersion(staging);
    if (!version) {
      try { version = String(fs.readFileSync(path.join(staging, 'VERSION'), 'utf8')).trim(); } catch (e) {}
    }
    const to = parse(version);
    if (!to) throw new Error('无法识别安装包版本号: ' + (version || '空'));
    const from = parse(currentVersion);
    if (from && cmp(to, from) <= 0) {
      throw new Error('该包版本 v' + version + ' 不高于当前 v' + currentVersion + ', 无需升级');
    }
    const noHelper = UPGRADE_PARTS.filter(f => !fs.existsSync(path.join(staging, f)));
    if (noHelper.length) throw new Error('安装包缺少在线升级组件(' + noHelper.join(', ') + '), 请使用 v1.8.0 及以后的服务端包');
    if (!findRuntime(staging)) throw new Error('安装包缺少内置运行时 (runtime/node.exe)');
    return { version, staging, files: files.length };
  } catch (e) {
    rimraf(staging);
    throw e;
  }
}

// 拉起接管进程后立即返回; 调用方负责随后退出主进程。
function apply(opts) {
  const runtime = findRuntime(opts.staging);
  if (!runtime) throw new Error('staging 中缺少运行时');
  const child = spawn(runtime, [
    path.join(opts.staging, 'upgrade-helper.js'),
    '--staging', opts.staging,
    '--target', opts.root,
    '--data', opts.dataDir,
    '--pid', String(opts.pid),
    '--to', opts.version,
  ], { cwd: opts.staging, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

module.exports = {
  CORE, UPGRADE_PARTS, readVersion, parse, cmp, findRuntime,
  upgradeDir, cleanup, stage, apply,
};
