'use strict';
// 可写路径解析。Windows 上把程序解压到「Program Files」或 C 盘根目录时,
// 普通权限进程无法在该目录建 data/ 或写 config.json, 旧版本会直接抛异常退出,
// 而启动器是隐藏窗口的, 于是表现为「双击后什么都没发生」。
// 这里在启动前探测可写性, 不可写就落到 %LOCALAPPDATA%\WinMon\data。
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.dirname(__dirname);

function probe(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(f, 'ok');
    fs.unlinkSync(f);
    return null;
  } catch (e) { return e.code || e.message; }
}

const envDir = process.env.WINMON_DATA_DIR;
const localData = path.join(ROOT, 'data');
const localError = probe(localData);

let DATA_DIR = localData;
let redirected = false;
let error = null;
if (envDir) {
  const envError = probe(envDir);
  if (envError) { error = envError; DATA_DIR = localError ? path.join(os.tmpdir(), 'WinMon', 'data') : localData; }
  else { DATA_DIR = envDir; redirected = envDir !== localData; }
} else if (localError) {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir() || os.tmpdir();
  const alt = path.join(base, 'WinMon', 'data');
  const altError = probe(alt);
  if (!altError) { DATA_DIR = alt; redirected = true; error = localError; }
  else {
    const tmp = path.join(os.tmpdir(), 'WinMon', 'data');
    const tmpError = probe(tmp);
    DATA_DIR = tmpError ? localData : tmp;
    redirected = !tmpError;
    error = tmpError || localError;
  }
}

// 配置优先读程序目录里随包分发的那份; 目录只读时改写数据目录中的副本。
const rootConfig = path.join(ROOT, 'config.json');
const rootConfigError = probe(ROOT);
let CONFIG_FILE = rootConfig;
if (rootConfigError) {
  CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(rootConfig)) {
    try { fs.writeFileSync(CONFIG_FILE, fs.readFileSync(rootConfig)); } catch (e) {}
  }
}

// pid / 日志等运行期文件写失败不应中断监控。
function writeQuiet(file, text) {
  try { fs.writeFileSync(file, text, 'utf8'); return true; }
  catch (e) { return false; }
}

module.exports = {
  ROOT,
  DATA_DIR,
  CONFIG_FILE,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  LOG_FILE: path.join(DATA_DIR, 'server.log'),
  PID_FILE: path.join(DATA_DIR, 'server.pid'),
  redirected,
  error,
  rootWritable: !rootConfigError,
  probe,
  writeQuiet,
};