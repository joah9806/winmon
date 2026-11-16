'use strict';
// 零依赖存储引擎, 兼容 Node 12 (Windows 7 最后支持的 LTS)。
// 元数据: 内存表 + JSON 原子快照; 历史: 按 主机/指标 分文件的定长二进制序列。
const fs = require('fs');
const path = require('path');

const REC = 16; // float64 ts + float64 value
const CHUNK = 4096;

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rimraf(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(p); } catch (e) { return; }
    for (const name of names) rimraf(path.join(p, name));
    try { fs.rmdirSync(p); } catch (e) {}
  } else {
    try { fs.unlinkSync(p); } catch (e) {}
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(file); } catch (e2) {}
    fs.renameSync(tmp, file);
  }
}

function downsample(rows, maxPoints) {
  if (!maxPoints || rows.length <= maxPoints) return rows;
  const bucket = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += bucket) {
    const slice = rows.slice(i, i + bucket);
    let sum = 0;
    for (const r of slice) sum += r.value;
    out.push({ ts: slice[Math.floor(slice.length / 2)].ts, value: sum / slice.length });
  }
  return out;
}

const TABLES = ['hosts', 'targets', 'checks', 'triggers', 'alerts'];

class MetaStore {
  constructor(file) {
    this.file = file;
    this.tables = {};
    this.seq = {};
    this.flags = {};
    for (const t of TABLES) { this.tables[t] = []; this.seq[t] = 0; }
    this._timer = null;
    this._dirty = false;
    this.loaded = this._load();
    process.on('exit', () => { try { this.flush(); } catch (e) {} });
  }

  _load() {
    if (!fs.existsSync(this.file)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of TABLES) {
        if (Array.isArray(raw[t])) this.tables[t] = raw[t];
        let max = 0;
        for (const r of this.tables[t]) if (r.id > max) max = r.id;
        this.seq[t] = Math.max(max, Number(raw.seq && raw.seq[t]) || 0);
      }
      if (raw.flags && typeof raw.flags === 'object') this.flags = raw.flags;
      return true;
    } catch (e) {
      console.error('[存储] store.json 解析失败, 改用空数据:', e.message);
      for (const t of TABLES) { this.tables[t] = []; this.seq[t] = 0; }
      this.flags = {};
      return false;
    }
  }

  nextId(table) { return ++this.seq[table]; }

  // 结构性改动立即落盘: stop.bat 用 taskkill /F 结束进程, 延迟写入会丢数据。
  save() {
    this._dirty = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.flush();
  }

  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 200);
  }

  flush() {
    if (!this._dirty) return;
    const payload = { version: 1, seq: this.seq, flags: this.flags };
    for (const t of TABLES) payload[t] = this.tables[t];
    try {
      atomicWrite(this.file, JSON.stringify(payload));
      this._dirty = false;
    } catch (e) {
      console.error('[存储] 写入失败:', e.message);
    }
  }

  close() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.flush();
  }
}

class Series {
  constructor(dir) {
    this.dir = dir;
    mkdirp(dir);
    this._lastTs = new Map();
    this._count = null;
  }

  hostDir(hostId) { return path.join(this.dir, 'h' + hostId); }
  file(hostId, item) {
    return path.join(this.hostDir(hostId), Buffer.from(String(item), 'utf8').toString('hex') + '.bin');
  }
  static itemOf(filename) {
    return Buffer.from(filename.replace(/\.bin$/, ''), 'hex').toString('utf8');
  }

  _hostDirs() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      if (!/^h\d+$/.test(n)) continue;
      const full = path.join(this.dir, n);
      try { if (fs.statSync(full).isDirectory()) out.push({ id: Number(n.slice(1)), dir: full }); } catch (e) {}
    }
    return out;
  }

  _files(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      if (!/^[0-9a-f]+\.bin$/.test(n)) continue;
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.size >= REC) out.push({ file: full, name: n, size: st.size });
      } catch (e) {}
    }
    return out;
  }

  _tailTs(file, size) {
    if (this._lastTs.has(file)) return this._lastTs.get(file);
    let ts = 0;
    if (size == null) { try { size = fs.statSync(file).size; } catch (e) { size = 0; } }
    if (size >= REC) {
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const b = Buffer.alloc(REC);
          fs.readSync(fd, b, 0, REC, size - REC);
          ts = b.readDoubleLE(0);
        } finally { fs.closeSync(fd); }
      } catch (e) {}
    }
    this._lastTs.set(file, ts);
    return ts;
  }

  append(hostId, metrics, ts) {
    const dir = this.hostDir(hostId);
    mkdirp(dir);
    let n = 0;
    for (const item of Object.keys(metrics)) {
      const value = metrics[item];
      if (typeof value !== 'number' || !isFinite(value)) continue;
      const file = this.file(hostId, item);
      // 序列必须按时间递增才能二分查找; 乱序上报时钳制到上一条之后。
      let t = ts;
      const last = this._tailTs(file, null);
      if (t <= last) t = last + 1;
      const b = Buffer.alloc(REC);
      b.writeDoubleLE(t, 0);
      b.writeDoubleLE(value, 8);
      try {
        const fd = fs.openSync(file, 'a');
        try { fs.writeSync(fd, b, 0, REC); } finally { fs.closeSync(fd); }
      } catch (e) {
        console.error('[存储] 历史写入失败:', item, e.message);
        continue;
      }
      this._lastTs.set(file, t);
      n++;
    }
    if (this._count != null) this._count += n;
    return n;
  }

  // 迁移专用: 一次性写入整条序列, 避免逐条 open/close。
  importSeries(hostId, item, rows) {
    if (!rows.length) return 0;
    const sorted = rows.slice().sort((a, b) => a.ts - b.ts);
    const file = this.file(hostId, item);
    mkdirp(this.hostDir(hostId));
    let last = this._tailTs(file, null);
    const buf = Buffer.alloc(sorted.length * REC);
    let n = 0;
    for (const r of sorted) {
      if (typeof r.value !== 'number' || !isFinite(r.value)) continue;
      let t = r.ts;
      if (t <= last) t = last + 1;
      buf.writeDoubleLE(t, n * REC);
      buf.writeDoubleLE(r.value, n * REC + 8);
      last = t;
      n++;
    }
    if (!n) return 0;
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, buf, 0, n * REC); } finally { fs.closeSync(fd); }
    this._lastTs.set(file, last);
    this._count = null;
    return n;
  }

  _lowerBound(fd, n, fromTs) {
    let lo = 0, hi = n;
    const b = Buffer.alloc(REC);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      fs.readSync(fd, b, 0, REC, mid * REC);
      if (b.readDoubleLE(0) < fromTs) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  range(hostId, item, fromTs, toTs, maxPoints) {
    const file = this.file(hostId, item);
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return []; }
    const n = Math.floor(size / REC);
    if (!n) return [];
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { return []; }
    try {
      const start = this._lowerBound(fd, n, fromTs);
      if (start >= n) return [];
      const rows = [];
      const buf = Buffer.alloc(CHUNK * REC);
      let idx = start;
      let stop = false;
      while (idx < n && !stop) {
        const want = Math.min(CHUNK, n - idx);
        const got = fs.readSync(fd, buf, 0, want * REC, idx * REC);
        const cnt = Math.floor(got / REC);
        if (!cnt) break;
        for (let i = 0; i < cnt; i++) {
          const ts = buf.readDoubleLE(i * REC);
          if (ts > toTs) { stop = true; break; }
          rows.push({ ts, value: buf.readDoubleLE(i * REC + 8) });
        }
        idx += cnt;
      }
      return downsample(rows, maxPoints);
    } finally { fs.closeSync(fd); }
  }

  latest(hostId) {
    const out = [];
    for (const f of this._files(this.hostDir(hostId))) {
      let fd;
      try { fd = fs.openSync(f.file, 'r'); } catch (e) { continue; }
      try {
        const b = Buffer.alloc(REC);
        fs.readSync(fd, b, 0, REC, f.size - REC);
        out.push({ item: Series.itemOf(f.name), value: b.readDoubleLE(8), ts: b.readDoubleLE(0) });
      } catch (e) {} finally { fs.closeSync(fd); }
    }
    out.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    return out;
  }

  items(hostId) {
    return this._files(this.hostDir(hostId)).map(f => Series.itemOf(f.name)).sort();
  }

  lastValues(hostId, item, n) {
    const file = this.file(hostId, item);
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return []; }
    const total = Math.floor(size / REC);
    if (!total) return [];
    const take = Math.min(n, total);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { return []; }
    try {
      const buf = Buffer.alloc(take * REC);
      const got = fs.readSync(fd, buf, 0, take * REC, (total - take) * REC);
      const cnt = Math.floor(got / REC);
      const out = [];
      for (let i = cnt - 1; i >= 0; i--) out.push(buf.readDoubleLE(i * REC + 8));
      return out;
    } finally { fs.closeSync(fd); }
  }

  count() {
    if (this._count != null) return this._count;
    let total = 0;
    for (const h of this._hostDirs()) {
      for (const f of this._files(h.dir)) total += Math.floor(f.size / REC);
    }
    this._count = total;
    return total;
  }

  cleanup(beforeTs) {
    let removed = 0;
    for (const h of this._hostDirs()) {
      for (const f of this._files(h.dir)) {
        const n = Math.floor(f.size / REC);
        let fd;
        try { fd = fs.openSync(f.file, 'r'); } catch (e) { continue; }
        let start;
        try { start = this._lowerBound(fd, n, beforeTs); }
        finally { fs.closeSync(fd); }
        if (start <= 0) continue;
        removed += start;
        if (start >= n) {
          rimraf(f.file);
          this._lastTs.delete(f.file);
          continue;
        }
        // 保留尾部: 重写为临时文件后替换, 避免原地移动覆盖未读数据。
        const tmp = f.file + '.tmp';
        let out;
        try {
          fd = fs.openSync(f.file, 'r');
          out = fs.openSync(tmp, 'w');
          const buf = Buffer.alloc(CHUNK * REC);
          let idx = start;
          while (idx < n) {
            const want = Math.min(CHUNK, n - idx);
            const got = fs.readSync(fd, buf, 0, want * REC, idx * REC);
            if (got <= 0) break;
            fs.writeSync(out, buf, 0, got);
            idx += Math.floor(got / REC);
          }
        } catch (e) {
          console.error('[存储] 历史压缩失败:', e.message);
        } finally {
          try { fs.closeSync(fd); } catch (e) {}
          try { fs.closeSync(out); } catch (e) {}
        }
        try {
          fs.unlinkSync(f.file);
          fs.renameSync(tmp, f.file);
        } catch (e) {
          console.error('[存储] 历史替换失败:', e.message);
          rimraf(tmp);
        }
      }
    }
    if (this._count != null) this._count = Math.max(0, this._count - removed);
    return removed;
  }

  removeHost(hostId) {
    const dir = this.hostDir(hostId);
    for (const f of this._files(dir)) this._lastTs.delete(f.file);
    rimraf(dir);
    this._count = null;
  }
}

module.exports = { MetaStore, Series, REC, TABLES, mkdirp, rimraf, atomicWrite, downsample };