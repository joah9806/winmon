'use strict';
// 只读 SQLite 解析器, 仅用于把 v1.4 及更早的 data/monitor.db 迁移到新的零依赖存储。
// 支持 WAL 叠加: 进程被强制结束时最新数据仍留在 -wal 文件中。
const fs = require('fs');

function varint(buf, pos) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos + i];
    if (b === undefined) return { value, next: pos + i };
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return { value, next: pos + i + 1 };
  }
  value = value * 256 + buf[pos + 8];
  return { value, next: pos + 9 };
}

const INT_LEN = [0, 1, 2, 3, 4, 6, 8];

function readIntBE(buf, off, len) {
  if (len === 8) return Number(buf.readBigInt64BE(off));
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  const limit = Math.pow(2, len * 8 - 1);
  return v >= limit ? v - limit * 2 : v;
}

function decodeText(buf, encoding) {
  if (encoding === 2) return buf.toString('utf16le');
  if (encoding === 3) {
    const sw = Buffer.from(buf);
    for (let i = 0; i + 1 < sw.length; i += 2) { const t = sw[i]; sw[i] = sw[i + 1]; sw[i + 1] = t; }
    return sw.toString('utf16le');
  }
  return buf.toString('utf8');
}

function decodeRecord(buf, encoding) {
  const h = varint(buf, 0);
  const headerSize = h.value;
  const types = [];
  let pos = h.next;
  while (pos < headerSize) {
    const t = varint(buf, pos);
    types.push(t.value);
    pos = t.next;
  }
  let dp = headerSize;
  const out = [];
  for (const t of types) {
    if (t === 0) out.push(null);
    else if (t >= 1 && t <= 6) { const len = INT_LEN[t]; out.push(readIntBE(buf, dp, len)); dp += len; }
    else if (t === 7) { out.push(buf.readDoubleBE(dp)); dp += 8; }
    else if (t === 8) out.push(0);
    else if (t === 9) out.push(1);
    else if (t >= 12 && t % 2 === 0) { const len = (t - 12) / 2; out.push(buf.slice(dp, dp + len)); dp += len; }
    else if (t >= 13) { const len = (t - 13) / 2; out.push(decodeText(buf.slice(dp, dp + len), encoding)); dp += len; }
    else out.push(null);
  }
  return out;
}

function splitDefs(sql) {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  const body = sql.slice(open + 1, close);
  const parts = [];
  let depth = 0, cur = '', quote = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function columnNames(sql) {
  const cols = [];
  for (const p of splitDefs(sql)) {
    const s = p.trim();
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(s)) continue;
    const m = s.match(/^["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/);
    if (m) cols.push(m[1]);
  }
  return cols;
}

// INTEGER PRIMARY KEY 是 rowid 的别名, 记录体里存的是 NULL, 需用 rowid 回填。
function pkAlias(sql) {
  for (const p of splitDefs(sql)) {
    const m = p.trim().match(/^["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s+INTEGER\s+PRIMARY\s+KEY\b/i);
    if (m) return m[1];
  }
  return null;
}

class Reader {
  constructor(file) {
    this.buf = fs.readFileSync(file);
    if (this.buf.length < 100 || this.buf.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
      throw new Error('不是有效的 SQLite 文件');
    }
    let ps = this.buf.readUInt16BE(16);
    if (ps === 1) ps = 65536;
    this.pageSize = ps;
    this.usable = ps - this.buf[20];
    this.encoding = this.buf.readUInt32BE(56) || 1;
    this.overlay = new Map();
    this.warning = '';
    this._loadWal(file + '-wal');
  }

  _loadWal(walFile) {
    if (!fs.existsSync(walFile)) return;
    let wal;
    try { wal = fs.readFileSync(walFile); } catch (e) { return; }
    if (wal.length < 32) return;
    const magic = wal.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return;
    const walPage = wal.readUInt32BE(8);
    if (walPage !== this.pageSize) { this.warning = 'WAL 页大小不匹配, 已忽略 WAL'; return; }
    const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
    const frameSize = 24 + this.pageSize;
    const frames = [];
    let lastCommit = 0;
    let off = 32, idx = 0;
    while (off + frameSize <= wal.length) {
      const pgno = wal.readUInt32BE(off);
      const trunc = wal.readUInt32BE(off + 4);
      const s1 = wal.readUInt32BE(off + 8), s2 = wal.readUInt32BE(off + 12);
      if (!pgno || s1 !== salt1 || s2 !== salt2) break;
      frames.push({ pgno, data: wal.slice(off + 24, off + 24 + this.pageSize) });
      idx++;
      if (trunc > 0) lastCommit = idx;
      off += frameSize;
    }
    // 只应用到最后一次提交, 避免写入未完成的尾部帧。
    const use = lastCommit > 0 ? frames.slice(0, lastCommit) : frames;
    for (const f of use) this.overlay.set(f.pgno, f.data);
    if (use.length) this.warning = '已从 WAL 恢复 ' + use.length + ' 个未落盘页';
  }

  page(n) {
    if (n <= 0) return null;
    if (this.overlay.has(n)) return this.overlay.get(n);
    const start = (n - 1) * this.pageSize;
    if (start + this.pageSize > this.buf.length) return null;
    return this.buf.slice(start, start + this.pageSize);
  }

  payload(page, start, size) {
    const U = this.usable;
    const maxLocal = U - 35;
    const minLocal = Math.floor((U - 12) * 32 / 255) - 23;
    let local;
    if (size <= maxLocal) local = size;
    else {
      const m = minLocal + ((size - minLocal) % (U - 4));
      local = m <= maxLocal ? m : minLocal;
    }
    const parts = [page.slice(start, start + local)];
    let remaining = size - local;
    if (remaining > 0) {
      let next = page.readUInt32BE(start + local);
      const seen = new Set();
      while (remaining > 0 && next && !seen.has(next)) {
        seen.add(next);
        const op = this.page(next);
        if (!op) break;
        const take = Math.min(remaining, U - 4);
        parts.push(op.slice(4, 4 + take));
        remaining -= take;
        next = op.readUInt32BE(0);
      }
    }
    return Buffer.concat(parts);
  }

  tableRows(rootPage) {
    const rows = [];
    const stack = [rootPage];
    const seen = new Set();
    while (stack.length) {
      const pgno = stack.pop();
      if (!pgno || seen.has(pgno)) continue;
      seen.add(pgno);
      const page = this.page(pgno);
      if (!page) continue;
      const base = pgno === 1 ? 100 : 0;
      const type = page[base];
      const count = page.readUInt16BE(base + 3);
      const ptr = base + (type === 0x05 || type === 0x02 ? 12 : 8);
      if (type === 0x05) {
        stack.push(page.readUInt32BE(base + 8));
        for (let i = 0; i < count; i++) stack.push(page.readUInt32BE(page.readUInt16BE(ptr + i * 2)));
      } else if (type === 0x0d) {
        for (let i = 0; i < count; i++) {
          const off = page.readUInt16BE(ptr + i * 2);
          const a = varint(page, off);
          const b = varint(page, a.next);
          const payload = this.payload(page, b.next, a.value);
          rows.push({ rowid: b.value, values: decodeRecord(payload, this.encoding) });
        }
      }
    }
    rows.sort((x, y) => x.rowid - y.rowid);
    return rows;
  }

  tables() {
    const out = {};
    for (const r of this.tableRows(1)) {
      const v = r.values;
      const type = v[0], name = v[1], rootPage = v[3], sql = v[4];
      if (type !== 'table' || typeof name !== 'string' || /^sqlite_/.test(name)) continue;
      const cols = columnNames(String(sql || ''));
      const alias = pkAlias(String(sql || ''));
      const rows = [];
      for (const row of this.tableRows(rootPage)) {
        const obj = { rowid: row.rowid };
        for (let i = 0; i < cols.length; i++) obj[cols[i]] = row.values[i] === undefined ? null : row.values[i];
        if (alias && obj[alias] == null) obj[alias] = row.rowid;
        rows.push(obj);
      }
      out[name] = { columns: cols, rows };
    }
    return out;
  }
}

function readSqlite(file) {
  const reader = new Reader(file);
  return { tables: reader.tables(), warning: reader.warning };
}

module.exports = { readSqlite, columnNames, decodeRecord, varint };