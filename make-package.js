'use strict';
// Release packager. Pure Node so it also runs on Windows 7 / PowerShell 2.0,
// where Compress-Archive and System.IO.Compression.ZipFile do not exist.
// 产物文件名带版本号, 包内附 VERSION 文件, 在线升级据此判断新旧。
//   node make-package.js server   -> winmon-server-windows-v<版本>.zip
//   node make-package.js agent    -> agent-windows-v<版本>.zip + agent-package.zip
//   node make-package.js linux    -> agent-linux-v<版本>.zip
//   node make-package.js all
const fs = require('fs');
const path = require('path');
const https = require('https');
const mkzip = require('./lib/mkzip');

const ROOT = __dirname;
const NODE_LINUX_VERSION = 'v24.22.3';

function readVersion() {
  const m = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/const VERSION = '([^']+)'/);
  if (!m) throw new Error('无法从 server.js 读取版本号');
  return m[1];
}
const VERSION = readVersion();
const versionEntry = () => ({ name: 'VERSION', data: Buffer.from(VERSION + '\n'), exec: false, mtime: Date.now() });

// 旧的固定文件名产物和本次同名产物都先删掉, 避免把上一版当成这一版上传。
function dropStale(names) {
  for (const n of names) { try { fs.unlinkSync(path.join(ROOT, n)); } catch (e) {} }
}

function entry(rel, name, exec) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error('缺少文件: ' + rel);
  const st = fs.statSync(full);
  return { name: name || rel.replace(/\\/g, '/'), data: fs.readFileSync(full), exec: !!exec, mtime: st.mtimeMs };
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (['.git', 'data', 'node_modules', 'agent-tmp'].includes(name)) continue;
      walk(full, rel, out);
      continue;
    }
    if (/\.(zip|log|pid|migrated|tmp|xz|gz)$/i.test(name)) continue;
    if (rel === 'runtime/node-linux') continue;
    if (rel === 'VERSION') continue;
    out.push({ name: rel, data: fs.readFileSync(full), exec: false, mtime: st.mtimeMs });
  }
  return out;
}

function save(outName, entries) {
  const out = path.join(ROOT, outName);
  const size = mkzip.write(out, entries);
  console.log('  ' + outName + '  ' + entries.length + ' 个文件  ' + (size / 1048576).toFixed(1) + ' MB');
}

function packServer() {
  const outName = 'winmon-server-windows-v' + VERSION + '.zip';
  console.log('[server] ' + outName);
  dropStale(['winmon-server-windows.zip', outName]);
  save(outName, walk(ROOT, '', []).concat([versionEntry()]));
}

const AGENT_FILES = [
  'agent.js', 'agent.bat', 'agent-background.bat', 'agent-stop.bat', 'agent-hidden.vbs',
  'pick-node.bat', 'stop.bat', 'config.json', 'CONFIG.md',
  'lib/paths.js', 'lib/log.js', 'lib/metrics.js', 'lib/collect.ps1', 'lib/httpc.js',
];

function packAgent() {
  const outName = 'agent-windows-v' + VERSION + '.zip';
  console.log('[agent] ' + outName + ' / agent-package.zip');
  const entries = [
    entry('runtime/node.exe', 'runtime/node.exe'),
    entry('runtime/node-x86.exe', 'runtime/node-x86.exe'),
  ].concat(AGENT_FILES.map(f => entry(f))).concat([versionEntry()]);
  dropStale(['agent-windows.zip', outName, 'agent-package.zip']);
  save(outName, entries);
  // agent-package.zip 是服务端本地生成的部署包, 界面 /download 接口按固定名下载。
  save('agent-package.zip', entries);
}

function download(url, dest, hops) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('重定向过多'));
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve()));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function packLinux() {
  const outName = 'agent-linux-v' + VERSION + '.zip';
  console.log('[linux] ' + outName);
  const bin = path.join(ROOT, 'runtime', 'node-linux');
  if (!fs.existsSync(bin)) {
    const url = `https://nodejs.org/dist/${NODE_LINUX_VERSION}/node-${NODE_LINUX_VERSION}-linux-x64.tar.xz`;
    console.log('  下载 Linux 运行时: ' + url);
    const tmp = path.join(ROOT, 'node-linux.tar.xz');
    await download(url, tmp, 0);
    const { execFileSync } = require('child_process');
    execFileSync('tar', ['-xJf', tmp, '-C', ROOT, `node-${NODE_LINUX_VERSION}-linux-x64/bin/node`], { stdio: 'inherit' });
    fs.renameSync(path.join(ROOT, `node-${NODE_LINUX_VERSION}-linux-x64`, 'bin', 'node'), bin);
    fs.unlinkSync(tmp);
    require('./lib/store').rimraf(path.join(ROOT, `node-${NODE_LINUX_VERSION}-linux-x64`));
  }
  const st = fs.statSync(bin);
  const entries = [{ name: 'runtime/node', data: fs.readFileSync(bin), exec: true, mtime: st.mtimeMs }];
  entries.push(entry('agent.js'), entry('agent.sh', 'agent.sh', true), entry('config.json'), entry('CONFIG.md'));
  entries.push(entry('lib/paths.js'), entry('lib/log.js'), entry('lib/metrics.js'), entry('lib/httpc.js'));
  entries.push(versionEntry());
  dropStale(['agent-linux.zip', outName]);
  save(outName, entries);
}

async function main() {
  const mode = process.argv[2] || 'all';
  if (!['server', 'agent', 'linux', 'all'].includes(mode)) {
    console.error('用法: node make-package.js [server|agent|linux|all]');
    process.exit(1);
  }
  if (mode === 'server' || mode === 'all') packServer();
  if (mode === 'agent' || mode === 'all') packAgent();
  if (mode === 'linux' || mode === 'all') await packLinux();
  console.log('打包完成。');
}

main().catch(e => { console.error('打包失败: ' + e.message); process.exit(1); });