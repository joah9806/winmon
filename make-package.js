'use strict';
// Release packager. Pure Node so it also runs on Windows 7 / PowerShell 2.0,
// where Compress-Archive and System.IO.Compression.ZipFile do not exist.
//   node make-package.js server   -> winmon-server-windows.zip
//   node make-package.js agent    -> agent-windows.zip + agent-package.zip
//   node make-package.js linux    -> agent-linux.zip
//   node make-package.js all
const fs = require('fs');
const path = require('path');
const https = require('https');
const mkzip = require('./lib/mkzip');

const ROOT = __dirname;
const NODE_LINUX_VERSION = 'v24.22.3';

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
  console.log('[server] winmon-server-windows.zip');
  save('winmon-server-windows.zip', walk(ROOT, '', []));
}

const AGENT_FILES = [
  'agent.js', 'agent.bat', 'pick-node.bat', 'stop.bat', 'config.json',
  'lib/paths.js', 'lib/metrics.js', 'lib/collect.ps1', 'lib/httpc.js',
];

function packAgent() {
  console.log('[agent] agent-windows.zip / agent-package.zip');
  const entries = [
    entry('runtime/node.exe', 'runtime/node.exe'),
    entry('runtime/node-x86.exe', 'runtime/node-x86.exe'),
  ].concat(AGENT_FILES.map(f => entry(f)));
  save('agent-windows.zip', entries);
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
  console.log('[linux] agent-linux.zip');
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
  entries.push(entry('agent.js'), entry('agent.sh', 'agent.sh', true), entry('config.json'));
  entries.push(entry('lib/paths.js'), entry('lib/metrics.js'), entry('lib/httpc.js'));
  save('agent-linux.zip', entries);
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