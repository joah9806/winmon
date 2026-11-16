'use strict';
// 极简 ZIP 读取器, 只服务在线升级的解包, 兼容 Node 12。
// 只依赖 zlib; 条目名、大小与 CRC 全部按中央目录校验, 不信任本地头。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./mkzip');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_ENTRIES = 5000;

function findEocd(buf) {
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// 拒绝绝对路径、盘符、.. 与空段, 目录条目返回 null。
function safeRel(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.slice(-1) === '/') return null;
  if (n.charAt(0) === '/' || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  for (const p of parts) if (!p || p === '.' || p === '..') return null;
  return parts.join('/');
}

function centralEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('ZIP 内文件过多(' + count + ')');
  if (cdOff + cdSize > buf.length) throw new Error('ZIP 中央目录越界');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP 中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    if ((flags & 0x0001) !== 0) throw new Error('不支持加密的 ZIP');
    out.push({
      name: buf.toString(flags & 0x0800 ? 'utf8' : 'binary', p + 46, p + 46 + nameLen),
      method, crc, compSize, size, localOff,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, e) {
  const p = e.localOff;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw new Error('ZIP 条目头损坏: ' + e.name);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compSize > buf.length) throw new Error('ZIP 条目数据越界: ' + e.name);
  const raw = buf.slice(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式(' + e.method + '): ' + e.name);
}

function list(zipFile) {
  return centralEntries(fs.readFileSync(zipFile)).map(e => ({
    name: e.name, size: e.size, dir: e.name.slice(-1) === '/' || e.name.slice(-1) === '\\',
  }));
}

// 解压到 destDir。maxTotal 限制解压后总量, 防止压缩炸弹。
function extract(zipFile, destDir, opts) {
  opts = opts || {};
  const maxTotal = opts.maxTotal || 512 * 1024 * 1024;
  const buf = fs.readFileSync(zipFile);
  const base = path.resolve(destDir);
  const written = [];
  let total = 0;
  for (const e of centralEntries(buf)) {
    const rel = safeRel(e.name);
    if (!rel) {
      if (String(e.name).replace(/\\/g, '/').slice(-1) === '/') continue;
      throw new Error('升级包含非法路径: ' + e.name);
    }
    total += e.size;
    if (total > maxTotal) throw new Error('升级包解压后超过 ' + Math.round(maxTotal / 1048576) + 'MB');
    const data = readEntry(buf, e);
    if (data.length !== e.size) throw new Error('条目大小不符: ' + rel);
    if (crc32(data) !== e.crc) throw new Error('条目校验失败: ' + rel);
    const out = path.resolve(base, rel);
    if (out !== base && out.indexOf(base + path.sep) !== 0) throw new Error('升级包路径越界: ' + e.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written.push(rel);
  }
  return written;
}

module.exports = { list, extract, safeRel };
