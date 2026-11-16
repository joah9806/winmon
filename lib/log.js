'use strict';
// 隐藏窗口启动时进程没有可见控制台, 日志必须自己落盘。
// 不用 cmd 的 ">> xxx.log" 重定向: 句柄被独占后重启写不进日志,
// 而重定向本身失败(目录只读)时错误也随隐藏窗口一起消失。
const fs = require('fs');
const util = require('util');

const BOM = String.fromCharCode(0xfeff);

module.exports = function teeLog(file) {
  let stream;
  try {
    // Win7 的记事本只有见到 BOM 才按 UTF-8 解码, 否则中文日志全是乱码。
    const fresh = !fs.existsSync(file) || fs.statSync(file).size === 0;
    stream = fs.createWriteStream(file, { flags: 'a' });
    if (fresh) stream.write(BOM);
  } catch (e) { return; }
  stream.on('error', () => {});
  for (const kind of ['log', 'error', 'warn']) {
    const orig = console[kind].bind(console);
    console[kind] = function () {
      const line = util.format.apply(null, arguments);
      try { stream.write('[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + line + '\n'); } catch (e) {}
      orig.apply(null, arguments);
    };
  }
};