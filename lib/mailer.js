'use strict';
const net = require('net');
const tls = require('tls');

function encodeHeader(s) {
  return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
}

function buildMessage(cfg, fromAddr, recipients, subject, text) {
  const fromHeader = cfg.from && cfg.from.includes('<') ? cfg.from : `<${fromAddr}>`;
  const body = Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${fromHeader}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@winmon>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

// 纯 Node 实现的 SMTP 客户端, 支持 SSL(465) / STARTTLS(587) / 明文(25) 与 AUTH LOGIN。
function sendMail(cfg, { subject, text }) {
  return new Promise((resolve, reject) => {
    if (!cfg || !cfg.enabled) return reject(new Error('邮件通知未启用'));
    if (!cfg.host) return reject(new Error('未配置 SMTP 服务器'));
    const recipients = String(cfg.to || '').split(/[,;，；\s]+/).map(s => s.trim()).filter(Boolean);
    if (!recipients.length) return reject(new Error('未配置收件人'));
    const fromRaw = cfg.from || cfg.user || '';
    const fromAddr = ((fromRaw.match(/<([^>]+)>/) || [, fromRaw])[1]).trim();
    if (!fromAddr) return reject(new Error('未配置发件人'));
    const mode = cfg.secure || 'starttls';
    const port = Number(cfg.port) || (mode === 'ssl' ? 465 : mode === 'starttls' ? 587 : 25);
    const message = buildMessage(cfg, fromAddr, recipients, subject, text);

    let socket, buffer = '', stage = 'greet', rcptIdx = 0, settled = false, tlsUpgraded = false;
    const timer = setTimeout(() => finish(new Error('SMTP 连接超时(20秒)')), 20000);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      if (err) reject(err); else resolve({ ok: true, recipients });
    }
    function write(line) { socket.write(line + '\r\n'); }
    function onErr(e) { finish(new Error('SMTP 连接错误: ' + e.message)); }

    function handle(code, line) {
      if (stage === 'greet') {
        if (code !== 220) return finish(new Error('SMTP 问候失败: ' + line));
        stage = 'ehlo'; write('EHLO winmon');
      } else if (stage === 'ehlo') {
        if (code !== 250) return finish(new Error('EHLO 失败: ' + line));
        if (mode === 'starttls' && !tlsUpgraded) { stage = 'starttls'; write('STARTTLS'); }
        else if (cfg.user) { stage = 'auth'; write('AUTH LOGIN'); }
        else { stage = 'mail'; write('MAIL FROM:<' + fromAddr + '>'); }
      } else if (stage === 'starttls') {
        if (code !== 220) return finish(new Error('STARTTLS 失败: ' + line));
        upgradeTLS();
      } else if (stage === 'auth') {
        if (code !== 334) return finish(new Error('服务器不支持 AUTH LOGIN: ' + line));
        stage = 'authUser'; write(Buffer.from(cfg.user, 'utf8').toString('base64'));
      } else if (stage === 'authUser') {
        if (code !== 334) return finish(new Error('SMTP 用户名被拒绝: ' + line));
        stage = 'authPass'; write(Buffer.from(cfg.pass || '', 'utf8').toString('base64'));
      } else if (stage === 'authPass') {
        if (code !== 235) return finish(new Error('SMTP 认证失败(用户名或密码错误): ' + line));
        stage = 'mail'; write('MAIL FROM:<' + fromAddr + '>');
      } else if (stage === 'mail') {
        if (code !== 250) return finish(new Error('发件人被拒绝: ' + line));
        stage = 'rcpt'; rcptIdx = 0; write('RCPT TO:<' + recipients[0] + '>');
      } else if (stage === 'rcpt') {
        if (code !== 250 && code !== 251) return finish(new Error('收件人被拒绝 ' + recipients[rcptIdx] + ': ' + line));
        rcptIdx++;
        if (rcptIdx < recipients.length) write('RCPT TO:<' + recipients[rcptIdx] + '>');
        else { stage = 'data'; write('DATA'); }
      } else if (stage === 'data') {
        if (code !== 354) return finish(new Error('DATA 被拒绝: ' + line));
        stage = 'body'; socket.write(message + '\r\n.\r\n');
      } else if (stage === 'body') {
        if (code !== 250) return finish(new Error('邮件发送失败: ' + line));
        stage = 'quit'; write('QUIT');
      } else if (stage === 'quit') {
        finish(null);
      }
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^\d{3} /.test(line)) { handle(Number(line.slice(0, 3)), line); break; }
      }
    }

    function upgradeTLS() {
      tlsUpgraded = true;
      const plain = socket;
      plain.removeListener('data', onData);
      plain.removeListener('error', onErr);
      const opts = { socket: plain, rejectUnauthorized: false };
      if (!net.isIP(cfg.host)) opts.servername = cfg.host;
      socket = tls.connect(opts, () => {
        stage = 'ehlo'; write('EHLO winmon');
      });
      socket.on('data', onData);
      socket.on('error', onErr);
    }

    const sslOpts = { host: cfg.host, port, rejectUnauthorized: false };
    if (!net.isIP(cfg.host)) sslOpts.servername = cfg.host;
    socket = mode === 'ssl' ? tls.connect(sslOpts) : net.connect({ host: cfg.host, port });
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

module.exports = { sendMail };