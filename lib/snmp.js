'use strict';
const dgram = require('node:dgram');

// ---- BER 编码 ----
function encLen(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, val) { return Buffer.concat([Buffer.from([tag]), encLen(val.length), val]); }
function encInt(n) {
  if (n === 0) return tlv(0x02, Buffer.from([0]));
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
function encOid(oid) {
  const p = oid.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function encStr(s) { return tlv(0x04, Buffer.from(s, 'utf8')); }
const NULL = Buffer.from([0x05, 0x00]);

// ---- BER 解码 ----
function readTlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  return { tag, start: off + hdr, len, end: off + hdr + len };
}
function decInt(buf, s, e) {
  let v = 0;
  const neg = buf[s] & 0x80;
  for (let i = s; i < e; i++) v = v * 256 + buf[i];
  if (neg) v -= Math.pow(256, e - s);
  return v;
}
function decUint(buf, s, e) {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + buf[i];
  return v;
}
function decOid(buf, s, e) {
  const out = [];
  let first = true, val = 0;
  for (let i = s; i < e; i++) {
    val = (val << 7) | (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      if (first) { out.push(Math.floor(val / 40), val % 40); first = false; }
      else out.push(val);
      val = 0;
    }
  }
  return out.join('.');
}
function decValue(buf, s, e, tag) {
  switch (tag) {
    case 0x02: return decInt(buf, s, e);
    case 0x41: case 0x42: case 0x43: case 0x46: return decUint(buf, s, e);
    case 0x04: return buf.slice(s, e).toString('utf8');
    case 0x06: return decOid(buf, s, e);
    case 0x40: return Array.from(buf.slice(s, e)).join('.');
    case 0x05: return null;
    default: return buf.slice(s, e).toString('hex');
  }
}

function buildGet(oids, community, version, reqId) {
  const vbs = oids.map(o => tlv(0x30, Buffer.concat([encOid(o), NULL])));
  const pdu = tlv(0xA0, Buffer.concat([encInt(reqId), encInt(0), encInt(0), tlv(0x30, Buffer.concat(vbs))]));
  return tlv(0x30, Buffer.concat([encInt(version === '1' ? 0 : 1), encStr(community), pdu]));
}

function parseResponse(buf) {
  const seq = readTlv(buf, 0);
  let off = seq.start;
  readTlv(buf, off); off = readTlv(buf, off).end; // version
  const com = readTlv(buf, off); off = com.end; // community
  const pdu = readTlv(buf, off);
  let p = pdu.start;
  const rid = readTlv(buf, p); p = rid.end;
  const err = readTlv(buf, p); p = err.end;
  const eidx = readTlv(buf, p); p = eidx.end;
  const vbs = readTlv(buf, p);
  const result = { error: decInt(buf, err.start, err.end), values: {} };
  let v = vbs.start;
  while (v < vbs.end) {
    const vb = readTlv(buf, v); v = vb.end;
    const oidT = readTlv(buf, vb.start);
    const valT = readTlv(buf, oidT.end);
    result.values[decOid(buf, oidT.start, oidT.end)] = decValue(buf, valT.start, valT.end, valT.tag);
  }
  return result;
}

function get(host, port, community, oids, version = '2c', timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const reqId = Math.floor(Math.random() * 0x7fffffff);
    const req = buildGet(oids, community, version, reqId);
    const timer = setTimeout(() => { sock.close(); reject(new Error('SNMP 超时')); }, timeout);
    sock.on('message', msg => {
      clearTimeout(timer);
      sock.close();
      try { resolve(parseResponse(msg)); }
      catch (e) { reject(new Error('SNMP 解析失败: ' + e.message)); }
    });
    sock.on('error', e => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(req, port, host, e => { if (e) { clearTimeout(timer); sock.close(); reject(e); } });
  });
}

const OID = {
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysDescr: '1.3.6.1.2.1.1.1.0',
  ifOperStatus: i => `1.3.6.1.2.1.2.2.1.8.${i}`,
  ifInOctets: i => `1.3.6.1.2.1.2.2.1.10.${i}`,
  ifOutOctets: i => `1.3.6.1.2.1.2.2.1.16.${i}`,
  ifHCInOctets: i => `1.3.6.1.2.1.31.1.1.1.6.${i}`,
  ifHCOutOctets: i => `1.3.6.1.2.1.31.1.1.1.10.${i}`,
  ifDescr: i => `1.3.6.1.2.1.2.2.1.2.${i}`,
};

module.exports = { get, OID, _internal: { buildGet, parseResponse, encOid, decOid } };