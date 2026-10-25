/* Pebble Launcher — Widget 轻量插件内核（REC-08）
 *
 * 设计取舍：只做「同源、已注册」的组件，不做远程 JS 动态加载。
 * 动态加载任意脚本等于把站点变成任意代码执行平台，而这个网站是
 * 官方下载页 —— 一个挂掉的第三方 widget 会直接毁掉「下载」这件事的可信度。
 * 想要社区组件，走 PR 进仓库，而不是运行时从 URL 拉。
 *
 * 契约（四个东西，别再多）：
 *   define(type, spec)   spec = { title?, mount(root, ctx) => cleanup? }
 *   ctx = { config, root, on(evt, fn), emit(evt, payload), setTheme(name) }
 *   on / emit           进程内事件总线，组件之间不互相引用
 *   <div data-widget="type" data-config='{"a":1}'>  挂载点
 */
(function () {
  'use strict';

  var registry = Object.create(null);
  var listeners = Object.create(null);
  var mounted = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function on(evt, fn) {
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return function () {
      var a = listeners[evt] || [];
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  function emit(evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        // 一个组件抛错不该带崩别的组件，也不该让整页白掉
        if (window.console) console.error('[widgets] ' + evt, e);
      }
    });
  }

  function define(type, spec) {
    if (!type || !spec || typeof spec.mount !== 'function') {
      throw new Error('define(type, spec) 需要 type 和 mount 函数');
    }
    registry[type] = spec;
    return spec;
  }

  /* ---------------- 主题 ---------------- */

  var THEMES = {
    teal: { accent: '#00b3a4', accent2: '#0a7ff0', grad: 'linear-gradient(135deg, #14c8b4 0%, #0a7ff0 100%)' },
    violet: { accent: '#7c5cff', accent2: '#c026a6', grad: 'linear-gradient(135deg, #8b6bff 0%, #c026a6 100%)' },
    amber: { accent: '#d97706', accent2: '#e11d48', grad: 'linear-gradient(135deg, #f59e0b 0%, #e11d48 100%)' }
  };

  function setTheme(name) {
    var t = THEMES[name];
    if (!t) return false;
    var root = document.documentElement;
    root.style.setProperty('--accent', t.accent);
    root.style.setProperty('--accent2', t.accent2);
    root.style.setProperty('--grad', t.grad);
    try {
      localStorage.setItem('pebble.accent', name);
    } catch (e) {}
    emit('theme', name);
    return true;
  }

  function savedTheme() {
    try {
      return localStorage.getItem('pebble.accent') || 'teal';
    } catch (e) {
      return 'teal';
    }
  }

  /* ---------------- 内置组件 ---------------- */

  define('clock', {
    title: '本地时间',
    mount: function (root) {
      root.innerHTML =
        '<div class="wg-big" data-slot="time">--:--:--</div>' +
        '<p class="wg-sub" data-slot="date">—</p>';
      var time = root.querySelector('[data-slot=time]');
      var date = root.querySelector('[data-slot=date]');
      var pad = function (n) {
        return (n < 10 ? '0' : '') + n;
      };
      function tick() {
        var d = new Date();
        time.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        date.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      }
      tick();
      var timer = setInterval(tick, 1000);
      return function () {
        clearInterval(timer);
      };
    }
  });

  define('version', {
    title: '最新版本',
    mount: function (root) {
      root.innerHTML =
        '<div class="wg-big" data-slot="v">—</div>' +
        '<p class="wg-sub" data-slot="meta">正在读取更新源…</p>';
      var v = root.querySelector('[data-slot=v]');
      var meta = root.querySelector('[data-slot=meta]');
      var alive = true;

      fetch('/api/update/latest', { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          if (!alive) return;
          v.textContent = 'v' + String(d.version || '').replace(/^v/i, '');
          meta.textContent = (d.publishedAt || '') + ' · ' + (d.url ? '可下载' : '暂无地址');
          emit('version', d);
        })
        .catch(function (e) {
          if (!alive) return;
          v.textContent = '离线';
          meta.textContent = '读不到更新源（' + e.message + '）';
        });

      return function () {
        alive = false;
      };
    }
  });

  define('palette', {
    title: '主题色',
    mount: function (root, ctx) {
      var names = Object.keys(THEMES);
      root.innerHTML =
        '<div class="wg-swatches">' +
        names
          .map(function (n) {
            return (
              '<button type="button" class="wg-sw" data-theme="' +
              n +
              '" aria-label="主题 ' +
              n +
              '" style="--sw:' +
              THEMES[n].accent +
              '"></button>'
            );
          })
          .join('') +
        '</div>' +
        '<p class="wg-sub">点一下换主题，记在这台浏览器里</p>';
      var current = ctx && ctx.config && ctx.config.current ? ctx.config.current : savedTheme();
      setTheme(current);

      root.addEventListener('click', function (e) {
        var b = e.target.closest('.wg-sw');
        if (!b) return;
        setTheme(b.getAttribute('data-theme'));
      });

      return function () {
        /* 事件绑在 root 上，root 被删就一起走了 */
      };
    }
  });

  /* ---------------- 挂载 ---------------- */

  function mountOne(el) {
    var type = el.getAttribute('data-widget');
    var spec = registry[type];
    if (!spec) {
      el.innerHTML = '<p class="wg-miss">没有注册这个组件：' + esc(type) + '</p>';
      return;
    }
    var config = {};
    var raw = el.getAttribute('data-config');
    if (raw) {
      try {
        config = JSON.parse(raw);
      } catch (e) {
        if (window.console) console.warn('[widgets] data-config 不是合法 JSON', el, e);
      }
    }
    var ctx = {
      config: config,
      root: el,
      on: on,
      emit: emit,
      setTheme: setTheme
    };
    var cleanup = null;
    try {
      cleanup = spec.mount(el, ctx);
    } catch (e) {
      el.innerHTML = '<p class="wg-miss">组件 ' + esc(type) + ' 出错：' + esc(e.message) + '</p>';
      if (window.console) console.error('[widgets] ' + type, e);
    }
    mounted.push({ el: el, type: type, cleanup: typeof cleanup === 'function' ? cleanup : null });
    emit('mounted', { type: type, el: el });
  }

  function scan(scope) {
    var rootEl = scope || document;
    var nodes = rootEl.querySelectorAll('[data-widget]:not([data-widget-ready])');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute('data-widget-ready', '1');
      mountOne(nodes[i]);
    }
    return nodes.length;
  }

  function unmountAll() {
    mounted.forEach(function (m) {
      if (m.cleanup) {
        try {
          m.cleanup();
        } catch (e) {}
      }
    });
    mounted = [];
  }

  window.PebbleWidgets = {
    define: define,
    on: on,
    emit: emit,
    scan: scan,
    unmountAll: unmountAll,
    setTheme: setTheme,
    list: function () {
      return Object.keys(registry);
    }
  };

  // 页面里如果有「页面级」主题记忆，进站先恢复，避免闪一下默认色
  var initial = savedTheme();
  if (initial !== 'teal') setTheme(initial);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      scan();
    });
  } else {
    scan();
  }
})();
