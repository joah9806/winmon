/* WinMon 浏览器兼容闸门。
   必须保持 ES5 语法: Windows 7 默认的 IE11 需要先运行本文件才能看到升级指引,
   若直接加载 app.js 会因模板字符串/箭头函数语法错误而白屏。 */
(function () {
  'use strict';

  function supports(fn) {
    try { return !!fn(); } catch (e) { return false; }
  }
  function syntaxOk(code) {
    return supports(function () { return new Function(code)(); });
  }

  var checks = [
    ['Promise', function () { return typeof Promise === 'function'; }],
    ['fetch', function () { return typeof window.fetch === 'function'; }],
    ['async/await', function () { return syntaxOk('return (async function(){ await 0; return 1; }) instanceof Function;'); }],
    ['箭头函数与模板字符串', function () { return syntaxOk('var f = function(x){ return x; }; return ((y) => `v${y}`)(1) === "v1";'); }],
    ['可选链 ?.', function () { return syntaxOk('var o = { a: 1 }; return o?.a === 1;'); }],
    ['空值合并 ??', function () { return syntaxOk('return (null ?? 7) === 7;'); }],
    ['Map / Set', function () { return typeof Map === 'function' && typeof Set === 'function'; }],
    ['Object.entries / assign', function () { return typeof Object.entries === 'function' && typeof Object.assign === 'function'; }],
    ['Array.find / includes', function () { return typeof [].find === 'function' && typeof [].includes === 'function'; }],
    ['String.padStart', function () { return typeof ''.padStart === 'function'; }],
    ['localStorage', function () { window.localStorage.setItem('__wm', '1'); window.localStorage.removeItem('__wm'); return true; }],
    ['Canvas 2D 图表', function () { return !!document.createElement('canvas').getContext('2d'); }],
    ['CSS 变量', function () { return window.CSS && CSS.supports && CSS.supports('color', 'var(--x)'); }],
    ['CSS Grid 布局', function () { return window.CSS && CSS.supports && CSS.supports('display', 'grid'); }],
    ['Flex gap 间距', function () { return window.CSS && CSS.supports && CSS.supports('gap', '8px'); }]
  ];

  var missing = [];
  for (var i = 0; i < checks.length; i++) {
    if (!supports(checks[i][1])) missing.push(checks[i][0]);
  }

  function loadApp() {
    var s = document.createElement('script');
    s.src = '/app.js';
    s.onerror = function () { document.getElementById('main').innerHTML = '<div style="padding:40px;color:#ff5c5c">前端脚本 app.js 加载失败, 请检查 public 目录是否完整。</div>'; };
    document.body.appendChild(s);
  }

  if (!missing.length) { loadApp(); return; }

  function browserLabel() {
    var ua = navigator.userAgent;
    var m;
    if (/MSIE\s([\d.]+)/.test(ua) || /Trident\/.*rv:([\d.]+)/.test(ua)) {
      m = ua.match(/MSIE\s([\d.]+)/) || ua.match(/rv:([\d.]+)/);
      return 'Internet Explorer ' + (m ? m[1] : '');
    }
    if (/Edge?\/([\d.]+)/.test(ua)) { m = ua.match(/Edge?\/([\d.]+)/); return 'Edge ' + m[1]; }
    if (/Firefox\/([\d.]+)/.test(ua)) { m = ua.match(/Firefox\/([\d.]+)/); return 'Firefox ' + m[1]; }
    if (/Chrome\/([\d.]+)/.test(ua)) { m = ua.match(/Chrome\/([\d.]+)/); return 'Chrome ' + m[1]; }
    return ua.slice(0, 80);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var css = ''
    + '.wm-gate{position:fixed;top:0;left:0;right:0;bottom:0;overflow:auto;background:#0d1117;color:#c9d4e5;'
    + 'font-family:"Microsoft YaHei","Segoe UI",Tahoma,sans-serif;font-size:14px;line-height:1.7;padding:32px 16px;}'
    + '.wm-gate *{box-sizing:border-box;}'
    + '.wm-wrap{max-width:860px;margin:0 auto;}'
    + '.wm-brand{font-size:22px;font-weight:bold;color:#fff;margin-bottom:4px;}'
    + '.wm-brand span{color:#4f8cff;}'
    + '.wm-card{background:#161d2b;border:1px solid #263149;border-radius:10px;padding:22px 24px;margin-top:18px;}'
    + '.wm-h{font-size:18px;font-weight:bold;color:#fff;margin:0 0 10px;}'
    + '.wm-warn{border-left:4px solid #ffa940;}'
    + '.wm-ok{border-left:4px solid #2ecc71;}'
    + '.wm-accent{border-left:4px solid #4f8cff;}'
    + '.wm-muted{color:#8493b8;}'
    + '.wm-code{font-family:Consolas,"Courier New",monospace;background:#0d1117;border:1px solid #263149;'
    + 'border-radius:6px;padding:8px 12px;color:#5ad1c9;word-break:break-all;display:block;margin:8px 0;}'
    + '.wm-list{margin:8px 0 0;padding-left:22px;}'
    + '.wm-list li{margin-bottom:6px;}'
    + '.wm-tag{display:inline-block;background:#2a1f1f;border:1px solid #5c3030;color:#ff9b9b;'
    + 'border-radius:4px;padding:2px 8px;margin:3px 6px 3px 0;font-size:12px;}'
    + '.wm-btn{display:inline-block;background:#4f8cff;color:#fff;border:0;border-radius:6px;'
    + 'padding:9px 18px;font-size:14px;cursor:pointer;font-family:inherit;}'
    + '.wm-btn:hover{background:#3d7ae8;}'
    + '.wm-tbl{width:100%;border-collapse:collapse;margin-top:10px;}'
    + '.wm-tbl th,.wm-tbl td{border:1px solid #263149;padding:8px 10px;text-align:left;font-size:13px;}'
    + '.wm-tbl th{background:#1b2333;color:#fff;}'
    + '.wm-foot{margin-top:18px;color:#8493b8;font-size:12px;text-align:center;}';

  var style = document.createElement('style');
  style.type = 'text/css';
  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);

  var tags = '';
  for (var j = 0; j < missing.length; j++) tags += '<span class="wm-tag">' + esc(missing[j]) + '</span>';

  var html = ''
    + '<div class="wm-gate"><div class="wm-wrap">'
    + '<div class="wm-brand">Win<span>Mon</span> 监控系统</div>'
    + '<div class="wm-muted">当前浏览器：' + esc(browserLabel()) + '</div>'

    + '<div class="wm-card wm-warn">'
    + '<div class="wm-h">浏览器版本过旧，无法显示监控界面</div>'
    + '<div>监控服务本身<strong style="color:#2ecc71">运行正常</strong>，数据采集与告警不受影响。'
    + '只是当前浏览器缺少界面所需的技术，因此无法渲染仪表盘。</div>'
    + '<div style="margin-top:12px" class="wm-muted">缺少的能力：</div>'
    + '<div>' + tags + '</div>'
    + '</div>'

    + '<div class="wm-card wm-accent">'
    + '<div class="wm-h">方案一（推荐，无需安装任何软件）</div>'
    + '<div>用局域网内<strong>另一台电脑或手机</strong>的浏览器直接访问本机地址：</div>'
    + '<span class="wm-code" id="wmLan">正在读取服务地址...</span>'
    + '<div class="wm-muted">Windows 7 作为监控服务器继续运行即可，界面在较新的设备上查看。</div>'
    + '</div>'

    + '<div class="wm-card">'
    + '<div class="wm-h">方案二：在本机安装支持 Windows 7 的浏览器</div>'
    + '<div class="wm-muted">下列版本是官方<strong>最后支持 Windows 7</strong> 的版本，更高版本无法在 Win7 安装：</div>'
    + '<table class="wm-tbl"><tr><th>浏览器</th><th>版本</th><th>说明</th></tr>'
    + '<tr><td>Google Chrome</td><td>109.0.5414.120</td><td>最后支持 Win7/8/8.1 的版本，需离线安装包</td></tr>'
    + '<tr><td>Mozilla Firefox</td><td>115 ESR</td><td>长期支持版，最后支持 Win7 的分支</td></tr>'
    + '</table>'
    + '<div style="margin-top:10px" class="wm-muted">安装后重新打开本页面即可。若本机不能联网，可在其它电脑下载安装包后拷贝过来。</div>'
    + '</div>'

    + '<div class="wm-card wm-ok">'
    + '<div class="wm-h">服务状态</div>'
    + '<div id="wmHealth" class="wm-muted">正在检测...</div>'
    + '<div style="margin-top:14px"><button class="wm-btn" id="wmRetry">重新检测</button></div>'
    + '</div>'

    + '<div class="wm-foot">WinMon 支持 Windows 7 SP1 / 8.1 / 10 / 11 作为服务端；界面需 Chrome 87+ 或 Firefox 78+。</div>'
    + '</div></div>';

  var host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);

  // 界面脚本没有加载, 顶栏按钮全是死控件, 直接隐藏避免误点与键盘聚焦。
  var header = document.querySelector('header');
  if (header) header.style.display = 'none';
  var main = document.getElementById('main');
  if (main) main.style.display = 'none';

  document.getElementById('wmRetry').onclick = function () { window.location.reload(); };

  // IE11 没有 fetch, 这里必须用 XMLHttpRequest。
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/health', true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var el = document.getElementById('wmHealth');
      var lan = document.getElementById('wmLan');
      if (xhr.status !== 200) {
        el.innerHTML = '<span style="color:#ff5c5c">无法连接服务接口 (HTTP ' + xhr.status + ')</span>';
        lan.innerHTML = 'http://' + window.location.host;
        return;
      }
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) { }
      var mins = Math.floor((d.uptime || 0) / 60);
      el.innerHTML = '服务运行中 · 版本 <strong style="color:#fff">' + esc(d.version || '?') + '</strong>'
        + ' · 运行时 Node ' + esc(d.node || '?')
        + ' · 已运行 ' + mins + ' 分钟';
      lan.innerHTML = esc(d.lan_url || ('http://' + window.location.host));
    };
    xhr.send();
  } catch (e) {
    document.getElementById('wmLan').innerHTML = 'http://' + window.location.host;
  }
})();