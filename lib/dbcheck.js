'use strict';
const net = require('net');
const crypto = require('crypto');

function connect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('连接超时')); }, timeout);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', e => { clearTimeout(t); reject(e); });
  });
}

class Reader {
  constructor(sock, timeout) {
    this.buf = Buffer.alloc(0);
    this.sock = sock;
    this.waiters = [];
    this.err = null;
    this.timer = setTimeout(() => this.fail(new Error('读取超时')), timeout);
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('连接被服务端关闭')));
  }
  fail(e) { this.err = e; clearTimeout(this.timer); for (const w of this.waiters) w.reject(e); this.waiters = []; }
  drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift();
      const out = this.buf.slice(0, w.n);
      this.buf = this.buf.slice(w.n);
      w.resolve(out);
    }
  }
  read(n) {
    if (this.err) return Promise.reject(this.err);
    if (this.buf.length >= n) { const out = this.buf.slice(0, n); this.buf = this.buf.slice(n); return Promise.resolve(out); }
    return new Promise((resolve, reject) => { this.waiters.push({ n, resolve, reject }); });
  }
  close() { clearTimeout(this.timer); this.sock.destroy(); }
}

const sha1 = b => crypto.createHash('sha1').update(b).digest();
const sha256 = b => crypto.createHash('sha256').update(b).digest();
function xor(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i % b.length]; return o; }

// ---------- Redis ----------
async function redis(p, timeout) {
  const sock = await connect(p.host, p.port || 6379, timeout);
  const r = new Reader(sock, timeout);
  const cmd = (...args) => Buffer.from('*' + args.length + '\r\n' + args.map(a => '$' + Buffer.byteLength(a) + '\r\n' + a + '\r\n').join(''));
  const line = async () => {
    const chunks = [];
    for (;;) { const b = await r.read(1); chunks.push(b); if (b[0] === 0x0a) break; }
    return Buffer.concat(chunks).toString('utf8').trim();
  };
  try {
    if (p.password) {
      sock.write(p.username ? cmd('AUTH', p.username, p.password) : cmd('AUTH', p.password));
      const a = await line();
      if (a.startsWith('-')) throw new Error('AUTH 失败: ' + a.slice(1));
    }
    sock.write(cmd('PING'));
    const resp = await line();
    if (resp === '+PONG') return { ok: 1 };
    if (resp.startsWith('-')) throw new Error(resp.slice(1));
    throw new Error('异常响应: ' + resp);
  } finally { r.close(); }
}

// ---------- MySQL / MariaDB ----------
function mysqlNative(pass, scramble) {
  if (!pass) return Buffer.alloc(0);
  const s1 = sha1(Buffer.from(pass));
  return xor(s1, sha1(Buffer.concat([scramble, sha1(s1)])));
}
function mysqlSha2(pass, scramble) {
  if (!pass) return Buffer.alloc(0);
  const s1 = sha256(Buffer.from(pass));
  return xor(s1, sha256(Buffer.concat([sha256(s1), scramble])));
}
async function mysql(p, timeout) {
  const sock = await connect(p.host, p.port || 3306, timeout);
  const r = new Reader(sock, timeout);
  const readPacket = async () => { const h = await r.read(4); const len = h[0] | h[1] << 8 | h[2] << 16; return r.read(len); };
  const sendPacket = (payload, seq) => { const h = Buffer.alloc(4); h[0] = payload.length & 0xff; h[1] = payload.length >> 8 & 0xff; h[2] = payload.length >> 16 & 0xff; h[3] = seq; sock.write(Buffer.concat([h, payload])); };
  try {
    const hs = await readPacket();
    if (hs[0] === 0xff) throw new Error('服务端拒绝: ' + hs.slice(3).toString('utf8'));
    let off = 1;
    while (hs[off] !== 0) off++; // version
    off += 1 + 4; // null + thread id
    const scr1 = hs.slice(off, off + 8); off += 8 + 1;
    off += 2 + 1 + 2 + 2; // cap lower, charset, status, cap upper
    const authLen = hs[off]; off += 1 + 10;
    const scr2 = hs.slice(off, off + Math.max(13, authLen - 8) - 1);
    let plugin = 'mysql_native_password';
    const rest = hs.slice(off + Math.max(13, authLen - 8));
    const z = rest.indexOf(0);
    if (z >= 0) plugin = rest.slice(0, z).toString('utf8');
    const scramble = Buffer.concat([scr1, scr2]);
    const user = p.user || 'root';
    const caps = 1 | 4 | 512 | 8192 | 32768 | 131072 | 524288;
    const mkAuth = pl => pl === 'caching_sha2_password' ? mysqlSha2(p.password || '', scramble) : mysqlNative(p.password || '', scramble);
    let auth = mkAuth(plugin);
    const body = Buffer.alloc(4 + 4 + 1 + 23);
    body.writeUInt32LE(caps, 0); body.writeUInt32LE(0x01000000, 4); body[8] = 45;
    const payload = Buffer.concat([body, Buffer.from(user + '\0'), Buffer.from([auth.length]), auth, Buffer.from(plugin + '\0')]);
    sendPacket(payload, 1);
    for (let i = 0; i < 6; i++) {
      const pkt = await readPacket();
      const t = pkt[0];
      if (t === 0x00) return { ok: 1 };
      if (t === 0xff) throw new Error('登录失败: ' + pkt.slice(9).toString('utf8'));
      if (t === 0xfe) { // AuthSwitchRequest
        const z2 = pkt.indexOf(0, 1);
        plugin = pkt.slice(1, z2).toString('utf8');
        const scr = pkt.slice(z2 + 1).replace(/\0$/, '');
        auth = plugin === 'caching_sha2_password' ? mysqlSha2(p.password || '', scr) : mysqlNative(p.password || '', scr);
        sendPacket(auth, 3);
        continue;
      }
      if (t === 0x01) { // AuthMoreData (caching_sha2)
        const sub = pkt[1];
        if (sub === 0x03) continue; // fast auth ok, next packet is OK
        if (sub === 0x04) { // full auth: request RSA public key
          sendPacket(Buffer.from([0x02]), 3);
          const keyPkt = await readPacket();
          const pem = keyPkt.slice(1).toString('utf8');
          const pw = Buffer.from((p.password || '') + '\0');
          const enc = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, xor(pw, scramble));
          sendPacket(enc, 5);
          continue;
        }
        throw new Error('未知认证扩展: ' + sub);
      }
      throw new Error('未知响应: 0x' + t.toString(16));
    }
    throw new Error('认证流程未完成');
  } finally { r.close(); }
}

// ---------- SQL Server (TDS) ----------
function tdsPacket(type, body) {
  const h = Buffer.alloc(8);
  h[0] = type; h[1] = 0x01;
  h.writeUInt16BE(8 + body.length, 2);
  h[6] = 1;
  return Buffer.concat([h, body]);
}
function tdsPassword(pass) {
  const u = Buffer.from(pass, 'utf16le');
  const o = Buffer.alloc(u.length);
  for (let i = 0; i < u.length; i++) { let b = u[i] ^ 0xA5; o[i] = ((b & 0x0f) << 4) | ((b & 0xf0) >> 4); }
  return o;
}
async function mssql(p, timeout) {
  const sock = await connect(p.host, p.port || 1433, timeout);
  const r = new Reader(sock, timeout);
  const readPacket = async () => { const h = await r.read(8); const len = h.readUInt16BE(2); return { type: h[0], body: await r.read(len - 8) }; };
  try {
    // PRELOGIN
    const pre = Buffer.from([0x00, 0x00, 0x06, 0x00, 0x06, 0x01, 0x00, 0x0c, 0x00, 0x01, 0x02, 0x00, 0x0d, 0x00, 0x00, 0xff, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    sock.write(tdsPacket(0x12, pre));
    await readPacket();
    // LOGIN7
    const user = p.user || 'sa', pass = p.password || '', db = p.db || '', app = 'WinMon';
    const enc = s => Buffer.from(s, 'utf16le');
    const vars = [enc(''), enc(user), tdsPassword(pass), enc(app), enc(p.host), enc(''), enc('ODBC'), enc(''), enc(db)];
    const fixed = 36 + vars.length * 4;
    let dataOff = fixed, offsets = [];
    for (const v of vars) { offsets.push([dataOff, v.length]); dataOff += v.length; }
    const head = Buffer.alloc(36);
    head.writeUInt32LE(0x74000004, 4); // TDS 7.4
    head.writeUInt32LE(4096, 8);
    head.writeUInt32LE(process.pid & 0xffffffff, 16);
    const ob = Buffer.alloc(vars.length * 4);
    offsets.forEach(([o, l], i) => { ob.writeUInt16LE(o, i * 4); ob.writeUInt16LE(l / 2, i * 4 + 2); });
    // password length is in bytes not chars
    ob.writeUInt16LE(vars[2].length, 2 * 4 + 2);
    const body = Buffer.concat([head, ob, ...vars]);
    body.writeUInt32LE(body.length, 0);
    sock.write(tdsPacket(0x10, body));
    for (let i = 0; i < 8; i++) {
      const { body: b } = await readPacket();
      let off = 0;
      while (off < b.length) {
        const tok = b[off];
        if (tok === 0xAD) return { ok: 1 }; // LOGINACK
        if (tok === 0xAA) { // ERROR
          const len = b.readUInt16LE(off + 1);
          const msgLen = b.readUInt16LE(off + 7);
          const msg = b.slice(off + 9, off + 9 + msgLen * 2).toString('utf16le');
          throw new Error('登录失败: ' + msg);
        }
        if (tok === 0xFD || tok === 0xFE || tok === 0xFF) { off += 1; continue; }
        if (off + 3 > b.length) break;
        const len = b.readUInt16LE(off + 1);
        off += 3 + len;
      }
    }
    throw new Error('未收到登录确认');
  } finally { r.close(); }
}

async function check(params, timeout = 8000) {
  const t0 = Date.now();
  const type = (params.dbtype || 'mysql').toLowerCase();
  try {
    let res;
    if (type === 'redis') res = await redis(params, timeout);
    else if (type === 'mysql' || type === 'mariadb') res = await mysql(params, timeout);
    else if (type === 'mssql' || type === 'sqlserver') res = await mssql(params, timeout);
    else { // 其它数据库退化为端口检测
      const s = await connect(params.host, params.port || 0, timeout);
      s.destroy(); res = { ok: 1 };
    }
    return { ok: res.ok, time: Date.now() - t0, error: '' };
  } catch (e) {
    return { ok: 0, time: Date.now() - t0, error: e.message };
  }
}

module.exports = { check, _internal: { mysqlNative, mysqlSha2, tdsPassword } };