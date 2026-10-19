// 后端自检（浏览器版）。逻辑与 cloudflare/pebble/smoke.mjs 一致，
// 但用 fetch 直接打目标地址 —— 所以能放在 CDN 上，打开网页就能测，不用开终端。
//
// ES5 写法，跟站点其他脚本一致（页面在旧浏览器里也要能跑）。

(function () {
  var $ = function (s) { return document.querySelector(s); };
  var out = $('#out');
  var baseInput = $('#base');
  var KEY = 'pebble.checkBackend.base';
  var DEFAULT_BASE = 'https://cf-pebble-backend.pages.dev';

  // ---------- 报告输出 ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function flush(html) { out.innerHTML = html; }
  function line(html) { flush(out.innerHTML + html + '\n'); }

  var pass = 0;
  var fail = 0;

  function passLine(name, detail) {
    pass++;
    line('<span class="ok">✓</span> ' + esc(name) +
      (detail ? '  <span class="chk-hint">' + esc(detail) + '</span>' : ''));
  }
  function failLine(name, detail) {
    fail++;
    line('<span class="bad">✗</span> ' + esc(name) +
      (detail ? '  <span class="chk-hint">' + esc(detail) + '</span>' : ''));
  }
  /** 返回布尔，方便在链条里决定要不要继续 */
  function check(name, cond, detail) {
    if (cond) passLine(name, detail); else failLine(name, detail);
    return !!cond;
  }

  // ---------- 请求 ----------

  function req(base, method, path, opt) {
    opt = opt || {};
    var headers = {};
    if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opt.token) headers['Authorization'] = 'Bearer ' + opt.token;
    return fetch(base + path, {
      method: method,
      headers: headers,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        return { status: res.status, data: data, raw: txt, headers: res.headers };
      });
    });
  }

  /** KV 最终一致：写完立刻读可能读不到，给它几秒 */
  function until(fn, tries, gap) {
    tries = tries || 8; gap = gap || 400;
    return fn().then(function (v) {
      if (v) return v;
      if (tries <= 1) return null;
      return new Promise(function (r) { setTimeout(r, gap); }).then(function () {
        return until(fn, tries - 1, gap);
      });
    });
  }

  // ---------- 只读检查 ----------

  function readOnly(base) {
    line('\n<span class="chk-sum">只读检查</span>  ' + esc(base));

    return req(base, 'GET', '/api/me').then(function (r) {
      if (r.status === 503) {
        failLine('服务在跑，但 KV 没绑', (r.data && r.data.error) || 'HTTP 503');
        line('');
        line('去 Pages 项目里把 Workers KV 命名空间绑定到变量名 KV，');
        line('然后重新部署一次（改绑定不会进已有部署）。');
        return { stop: true };
      }
      check('服务可达、KV 已绑定', r.status !== 503, 'HTTP ' + r.status);
      check('未登录访问 /api/me 被拒 401', r.status === 401, 'HTTP ' + r.status);

      return req(base, 'GET', '/api/nope').then(function (nf) {
        check('未知路径返回 404（不是 503）', nf.status === 404, 'HTTP ' + nf.status);
        return fetch(base + '/api/me', { method: 'OPTIONS' });
      }).then(function (pre) {
        var acao = pre.headers.get('access-control-allow-origin');
        check('跨域预检 204 且允许来源', pre.status === 204 && acao === '*',
          'HTTP ' + pre.status + (acao ? ' ACAO=' + acao : ' 无 ACAO 头'));
      });
    });
  }

  // ---------- 完整测试 ----------

  function full(base) {
    var user = 'check_' + Date.now().toString(36);
    var pwd = 'pw-' + Math.random().toString(36).slice(2, 10);
    var token = null;
    var blobKey = 'check/hello';

    line('\n<span class="chk-sum">完整测试</span>  临时账号 ' + esc(user));

    return req(base, 'POST', '/api/auth/register', { body: { username: user, password: pwd } })
      .then(function (r) {
        if (!check('注册成功', r.status === 200 && r.data && r.data.ok === true,
          'HTTP ' + r.status + ' ' + ((r.data && r.data.error) || ''))) {
          return null;
        }
        return req(base, 'POST', '/api/auth/register', { body: { username: user, password: pwd } });
      })
      .then(function (dup) {
        if (!dup) return null;
        check('重复注册被拒 409', dup.status === 409, 'HTTP ' + dup.status);
        return req(base, 'POST', '/api/auth/register', { body: { username: 'x', password: '1' } });
      })
      .then(function (weak) {
        if (!weak) return null;
        check('弱口令被拒 400', weak.status === 400, 'HTTP ' + weak.status);
        return req(base, 'POST', '/api/auth/login', { body: { username: user, password: pwd + 'x' } });
      })
      .then(function (badPwd) {
        if (!badPwd) return null;
        check('错误密码被拒 401', badPwd.status === 401, 'HTTP ' + badPwd.status);
        return req(base, 'POST', '/api/auth/login', { body: { username: user, password: pwd } });
      })
      .then(function (login) {
        if (!login) return null;
        token = login.data && login.data.token;
        if (!check('登录拿到 token', !!token, 'HTTP ' + login.status)) return null;
        return req(base, 'GET', '/api/me', { token: token });
      })
      .then(function (me) {
        if (!me) return null;
        return check('带 token 读 /api/me', me.status === 200 && me.data && me.data.username === user, 'HTTP ' + me.status)
          ? req(base, 'GET', '/api/me', { token: 'not-a-real-token' }) : null;
      })
      .then(function (fake) {
        if (!fake) return null;
        check('伪造 token 被拒 401', fake.status === 401, 'HTTP ' + fake.status);
        return req(base, 'PUT', '/api/blob/item?key=' + encodeURIComponent(blobKey), { token: token, body: { data: { msg: '你好，Pebble', n: 42 } } });
      })
      .then(function (w) {
        if (!w) return null;
        if (!check('写入云存档', w.status === 200 && w.data && w.data.ok === true, 'HTTP ' + w.status)) return null;
        return until(function () {
          return req(base, 'GET', '/api/blob/item?key=' + encodeURIComponent(blobKey), { token: token })
            .then(function (r) { return r.data && r.data.exists ? r : null; });
        });
      })
      .then(function (got) {
        if (!got) return null;
        return check('读回且内容一致',
          JSON.stringify(got.data.data) === JSON.stringify({ msg: '你好，Pebble', n: 42 }))
          ? until(function () {
            return req(base, 'GET', '/api/blob', { token: token })
              .then(function (r) {
                return r.data && r.data.keys && r.data.keys.indexOf('check/hello') >= 0 ? r : null;
              });
          }) : null;
      })
      .then(function (list) {
        if (!list) return null;
        return check('列表里能看到该条', list.status === 200)
          ? req(base, 'DELETE', '/api/blob/item?key=' + encodeURIComponent(blobKey), { token: token }) : null;
      })
      .then(function (d) {
        if (!d) return null;
        check('删除云存档', d.status === 200, 'HTTP ' + d.status);
        return d;
      });
  }

  // ---------- 跑 ----------

  function summary() {
    line('');
    line('<span class="chk-sum ' + (fail ? 'bad' : 'ok') + '">通过 ' + pass + '　失败 ' + fail + '</span>');
    if (!fail) line('<span class="ok">后端正常，可以用。</span>');
  }

  function run(fullMode) {
    var base = (baseInput.value || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
      flush('<span class="bad">✗</span> 地址得是 http(s) 开头的，比如 ' + esc(DEFAULT_BASE));
      return;
    }
    try { localStorage.setItem(KEY, base); } catch (e) { /* 隐私模式存不了，无所谓 */ }

    pass = 0; fail = 0;
    flush('正在检查 ' + esc(base) + ' …');

    readOnly(base).then(function (r) {
      if (r && r.stop) { summary(); return; }
      if (!fullMode) { summary(); return; }
      return full(base);
    }).then(summary, function (e) {
      failLine('请求失败', (e && e.message) || String(e));
      if (e && /Failed to fetch|NetworkError|Load failed/i.test((e && e.message) || '')) {
        line('多半是地址打不开、被浏览器拦了，或者对方没放开跨域。');
      }
      summary();
    });
  }

  // ---------- 初始化 ----------

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) baseInput.value = saved;
  } catch (e) { /* 忽略 */ }
  if (!baseInput.value) baseInput.value = DEFAULT_BASE;

  $('#run-ro').addEventListener('click', function () { run(false); });
  $('#run-full').addEventListener('click', function () { run(true); });
  baseInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(false); });
})();
