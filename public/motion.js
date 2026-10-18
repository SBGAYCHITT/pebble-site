/* Pebble Lunchar 官网 · 动效
 *
 * 两件事，都是纯本地：
 *   1) 背景的粒子海洋 —— 波浪自己起伏，鼠标靠近会被推开，松手弹回；按下是一圈涟漪
 *   2) 标题里「好」字的横向增殖 —— 定时往右冒几个残影，读起来像同一个字在变多
 *
 * 约束：
 *   - 不引任何库、不发任何请求（站点要能断网打开）
 *   - prefers-reduced-motion 时全部不动，只画一帧静景
 *   - 标签页切到后台就停，别偷偷烧 CPU
 *   - 粒子按格子生成，密度随窗口宽高算，不写死数量
 */
(function () {
  'use strict';

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ======================= 一、粒子海洋 ======================= */

  var cvs = document.getElementById('sea');
  var ctx = null;
  try {
    ctx = cvs && cvs.getContext ? cvs.getContext('2d') : null;
  } catch (e) {
    ctx = null; // 极端情况下拿不到 2d 上下文，页面照常可用
  }

  if (ctx) {
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0;
    var H = 0;
    var pts = [];
    var gapX = 22;
    var gapY = 20;
    var RADIUS = 152;
    var RADIUS2 = RADIUS * RADIUS;
    var mx = -9999;
    var my = -9999;
    var mouseOn = false;
    var ripples = [];
    var raf = 0;

    // 两层波叠起来：第一层沿 x 走，决定"浪往哪边推"；
    // 第二层只跟 y 走，让同一行的粒子一起上下，行才看得见是行。
    // 振幅合计必须小于行距（22px），否则行会互相穿插 —— 那就成了纯噪点，不是海。
    var WAVE_MAX = 13;
    function waveAt(hx, hy, ph, t) {
      return Math.sin(hx * 0.012 + t * 0.85) * 9 + Math.sin(hy * 0.01 - t * 0.5 + ph) * 4;
    }

    // 浪尖→浪谷的配色（青绿 → 蓝），预生成，避免每帧拼 rgba 字符串
    var PALETTE = [];
    for (var pc = 0; pc < 16; pc++) {
      var k = pc / 15;
      var r = Math.round(20 + (10 - 20) * k);
      var g = Math.round(200 + (127 - 200) * k);
      var b = Math.round(180 + (240 - 180) * k);
      PALETTE.push('rgb(' + r + ',' + g + ',' + b + ')');
    }

    function build() {
      pts.length = 0;
      var cols = Math.ceil(W / gapX) + 1;
      var rows = Math.ceil(H / gapY) + 1;
      // 上限兜一下：超宽屏 / 超长屏别让粒子数炸掉。
      // 必须循环放大 —— 只放大一次的话，4K 屏仍然会算出上万颗
      var guard = 0;
      while (cols * rows > 4200 && guard++ < 5) {
        gapX *= 1.3;
        gapY *= 1.3;
        cols = Math.ceil(W / gapX) + 1;
        rows = Math.ceil(H / gapY) + 1;
      }
      for (var row = 0; row < rows; row++) {
        for (var col = 0; col < cols; col++) {
          var hx = col * gapX;
          var hy = row * gapY;
          pts.push({
            hx: hx,
            hy: hy,
            x: hx,
            y: hy,
            vx: 0,
            vy: 0,
            ph: hx * 0.013 + hy * 0.021
          });
        }
      }
    }

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      cvs.width = Math.round(W * DPR);
      cvs.height = Math.round(H * DPR);
      cvs.style.width = W + 'px';
      cvs.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      var narrow = W < 720;
      gapX = narrow ? 28 : 22;
      gapY = narrow ? 24 : 20;
      build();
    }

    function frame(now) {
      var t = now * 0.001;

      // 涟漪向外扩，同时衰减
      for (var ri = ripples.length - 1; ri >= 0; ri--) {
        var rp = ripples[ri];
        rp.r += 7.5;
        rp.life -= 0.011;
        if (rp.life <= 0) ripples.splice(ri, 1);
      }

      ctx.clearRect(0, 0, W, H);

      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];

        // 两个不同频率、不同方向的波叠起来，才不像"整齐的呼吸"
        var wave = waveAt(p.hx, p.hy, p.ph, t);
        var tx = p.hx;
        var ty = p.hy + wave;

        var prox = 0;

        // 鼠标推开：越近力越大，二次衰减，边缘自然
        if (mouseOn) {
          var dx = p.x - mx;
          var dy = p.y - my;
          var d2 = dx * dx + dy * dy;
          if (d2 < RADIUS2) {
            var d = Math.sqrt(d2) || 0.001;
            // 线性衰减而不是平方：平方在手边衰减太快，坑只有 40px，看着像没反应
            var f = (1 - d / RADIUS) * 7;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
            prox = 1 - d / RADIUS;
          }
        }

        // 点击涟漪：一圈正在经过的波把粒子向外推
        for (var q = 0; q < ripples.length; q++) {
          var r2 = ripples[q];
          var rx = p.x - r2.x;
          var ry = p.y - r2.y;
          var rd = Math.sqrt(rx * rx + ry * ry) || 0.001;
          var band = Math.abs(rd - r2.r);
          if (band < 36) {
            var rf = (1 - band / 36) * 3.2 * r2.life;
            p.vx += (rx / rd) * rf;
            p.vy += (ry / rd) * rf;
          }
        }

        // 弹簧回位。0.022 是"想回去的劲"，0.90 是阻尼 —— 太大会抖，太小像果冻
        p.vx += (tx - p.x) * 0.022;
        p.vy += (ty - p.y) * 0.022;
        p.vx *= 0.9;
        p.vy *= 0.9;
        // 速度封顶：快速横扫时别把粒子甩到屏幕外
        if (p.vx > 28) p.vx = 28;
        else if (p.vx < -28) p.vx = -28;
        if (p.vy > 28) p.vy = 28;
        else if (p.vy < -28) p.vy = -28;
        p.x += p.vx;
        p.y += p.vy;

        // 浪尖更青、更亮；谷底更蓝、更淡
        var crest = wave / WAVE_MAX;
        if (crest > 0.999) crest = 0.999;
        if (crest < -0.999) crest = -0.999;
        var kk = (crest + 1) / 2;
        var idx = Math.round(kk * 15);
        var alpha = 0.1 + kk * 0.2 + prox * 0.32;
        if (alpha > 0.8) alpha = 0.8;
        // 浪尖的点略大一点：不用画线，也能看出"这里高"
        var size = 1.2 + kk * 1.1;

        ctx.globalAlpha = alpha;
        ctx.fillStyle = PALETTE[idx];
        ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (!raf) raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    function drawStill() {
      // 不动的时候也要有画面：画一帧完整的浪，不启动循环
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var wave = waveAt(p.hx, p.hy, p.ph, 0);
        var y = p.hy + wave;
        var crest = wave / WAVE_MAX;
        if (crest > 0.999) crest = 0.999;
        if (crest < -0.999) crest = -0.999;
        var ks = (crest + 1) / 2;
        var ss = 1.2 + ks * 1.1;
        ctx.globalAlpha = 0.1 + ks * 0.2;
        ctx.fillStyle = PALETTE[Math.round(ks * 15)];
        ctx.fillRect(p.hx - ss / 2, y - ss / 2, ss, ss);
      }
      ctx.globalAlpha = 1;
    }

    var resizeTimer = 0;
    window.addEventListener(
      'resize',
      function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          resize();
          if (reduceMotion) drawStill();
        }, 140);
      },
      { passive: true }
    );

    window.addEventListener(
      'pointermove',
      function (e) {
        mx = e.clientX;
        my = e.clientY;
        mouseOn = true;
      },
      { passive: true }
    );

    window.addEventListener(
      'pointerdown',
      function (e) {
        // 只对左键/触摸起涟漪，右键和中键不打扰
        if (e.button && e.button !== 0) return;
        ripples.push({ x: e.clientX, y: e.clientY, r: 0, life: 1 });
        if (ripples.length > 6) ripples.shift();
      },
      { passive: true }
    );

    // 指针离开文档（不是离开某个元素）才真正"松手"
    window.addEventListener('pointerout', function (e) {
      if (!e.relatedTarget) mouseOn = false;
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else if (!reduceMotion) start();
    });

    resize();
    if (reduceMotion) {
      drawStill();
    } else {
      start();
    }
  }

  /* ======================= 二、「好」字增殖 ======================= */

  var hao = document.querySelector('.hao');
  if (hao && !reduceMotion) {
    var busy = false;
    var lastHover = 0;

    function bloom() {
      if (busy) return;
      busy = true;

      // 重启动画：先摘类、强制重排、再挂回去
      hao.classList.remove('bloom');
      void hao.offsetWidth;
      hao.classList.add('bloom');

      // 三个残影，间距 .22em —— 正好落在「好」与下一个「好」之间的空隙里，
      // 不会糊到后一个字上
      for (var i = 1; i <= 3; i++) {
        (function (n) {
          // 隔 110ms 出一个：先一个，再两个，再三个 —— 是"变多"，不是一闪
          window.setTimeout(function () {
            var echo = document.createElement('span');
            echo.className = 'hao-echo';
            echo.textContent = '好';
            echo.setAttribute('aria-hidden', 'true');
            echo.style.setProperty('--i', String(n));
            hao.appendChild(echo);
            window.setTimeout(function () {
              if (echo.parentNode) echo.parentNode.removeChild(echo);
            }, 1000);
          }, n * 110);
        })(i);
      }

      window.setTimeout(function () {
        busy = false;
      }, 640);
    }

    // 没人搭理的时候自己也动，4.8 秒一次，不抢注意力
    window.setInterval(function () {
      if (document.visibilityState === 'visible') bloom();
    }, 4800);

    // 鼠标扫过标题时更积极一点，但至少隔 1.1 秒才来一次
    var h1 = document.querySelector('h1');
    if (h1) {
      h1.addEventListener('pointerenter', function () {
        var now = Date.now();
        if (now - lastHover < 1100) return;
        lastHover = now;
        bloom();
      });
    }
  }
})();
