'use strict';
// 基于 http/https 的请求助手, 替代 Node 18+ 的全局 fetch 与 Node 15+ 的 AbortController。
// Node 12 (Windows 7) 没有这两个 API, 因此自行实现超时、重定向与响应体上限。
const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function normalize(url) {
  const s = String(url || '').trim();
  if (!s) throw new Error('URL 为空');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
}

function pick(u) {
  return u.protocol === 'https:' ? https : http;
}

// 完整请求: 收集响应体, 用于 Agent 上报与 Webhook。
function request(url, opts) {
  const o = opts || {};
  const timeout = o.timeout == null ? 10000 : o.timeout;
  const maxBytes = o.maxBytes == null ? DEFAULT_MAX_BYTES : o.maxBytes;
  const maxRedirects = o.maxRedirects == null ? MAX_REDIRECTS : o.maxRedirects;

  return new Promise((resolve, reject) => {
    let hops = 0;
    const send = (target, method, payload) => {
      let u;
      try { u = new URL(normalize(target)); } catch (e) { return reject(new Error('URL 无效: ' + target)); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error('不支持的协议: ' + u.protocol));
      }
      const headers = Object.assign({}, o.headers || {});
      if (payload != null) headers['Content-Length'] = Buffer.byteLength(payload);
      const reqOpts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      };
      if (u.protocol === 'https:' && o.insecure) reqOpts.rejectUnauthorized = false;
      if (u.username || u.password) {
        reqOpts.auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
      }
      let settled = false;
      let req;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { req.destroy(); } catch (e) {} reject(err); }
        else resolve(val);
      };
      const timer = setTimeout(() => done(new Error('请求超时(' + timeout + 'ms)')), timeout);

      req = pick(u).request(reqOpts, res => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].indexOf(status) >= 0 && hops < maxRedirects) {
          hops++;
          res.resume();
          let next;
          try { next = new URL(loc, u).toString(); } catch (e) { return done(new Error('重定向地址无效: ' + loc)); }
          // 303 及 301/302 的历史行为: 转为 GET 且丢弃请求体。
          const nm = status === 307 || status === 308 ? method : 'GET';
          return send(next, nm, nm === 'GET' ? null : payload);
        }
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) { truncated = true; res.destroy(); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          done(null, {
            status,
            ok: status >= 200 && status < 300,
            headers: res.headers,
            truncated,
            body,
            text: () => body.toString('utf8'),
            json: () => JSON.parse(body.toString('utf8')),
          });
        });
        res.on('error', e => { if (!truncated) done(e); else done(null, { status, ok: status >= 200 && status < 300, headers: res.headers, truncated: true, body: Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString('utf8'), json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
      });
      req.on('error', e => done(e));
      if (payload != null) req.write(payload);
      req.end();
    };
    send(url, o.method || 'GET', o.body == null ? null : o.body);
  });
}

// 只关心状态码与响应时间: 收到响应头即结束, 不下载响应体。
// 用于探测 Web 服务存活, 因此忽略证书有效性(内网设备普遍自签)。
function status(url, timeout) {
  const t0 = Date.now();
  return new Promise(resolve => {
    let hops = 0;
    const finish = v => resolve(v);
    const send = target => {
      let u;
      try { u = new URL(normalize(target)); }
      catch (e) { return finish({ ok: 0, status: 0, time: Date.now() - t0 }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return finish({ ok: 0, status: 0, time: Date.now() - t0 });
      }
      const reqOpts = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': 'WinMon-Probe', Connection: 'close' },
      };
      if (u.protocol === 'https:') reqOpts.rejectUnauthorized = false;
      let settled = false;
      let req;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { req.destroy(); } catch (e) {}
        finish(v);
      };
      const timer = setTimeout(() => done({ ok: 0, status: 0, time: Date.now() - t0 }), timeout || 8000);
      req = pick(u).request(reqOpts, res => {
        const code = res.statusCode || 0;
        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].indexOf(code) >= 0 && hops < MAX_REDIRECTS) {
          hops++;
          res.resume();
          let next;
          try { next = new URL(loc, u).toString(); } catch (e) { return done({ ok: 0, status: code, time: Date.now() - t0 }); }
          return send(next);
        }
        done({ ok: code >= 200 && code < 400 ? 1 : 0, status: code, time: Date.now() - t0 });
      });
      req.on('error', () => done({ ok: 0, status: 0, time: Date.now() - t0 }));
      req.end();
    };
    send(url);
  });
}

module.exports = { request, status, normalize };