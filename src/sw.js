/* Pebble Launcher 的 Service Worker
 *
 * 这个文件不是手写的产物：build.mjs 会读它，把版本号占位符和预缓存清单换掉，
 * 再写到 dist/sw.js。改缓存策略改这里，不要改 dist 里的。
 *
 * 三档策略，和 _headers 的缓存分级对齐：
 *   页面导航    network-first    HTML 是 no-cache，联网时永远拿到最新；
 *                               断网/超时才回落缓存，顺带解决 "Cloudflare 慢" 时白屏
 *   清单接口    network-first    /data/*、/api/*，更新信息不能吃旧缓存
 *   静态资源    cache-first      /assets/* 名字里带内容哈希，内容变就换名字
 */

const VERSION = '__VERSION__';
const CACHE = 'pebble-' + VERSION;
const PRECACHE = __PRECACHE__;
const OFFLINE_URL = '/';
const NAV_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个 add 而不是 addAll：清单里挂了一个 404，addAll 会让整轮 install 失败，
      // 结果就是"离线能力静默消失"。这里允许个别失败。
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (e) {
            /* 单个资源失败不影响其余 */
          }
        }),
      );
      // 不调 skipWaiting：新版本等所有页面关掉再接管，
      // 避免「旧 HTML 还在屏幕上、新 SW 已经把它引用的旧指纹资源删了」。
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('pebble-') && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return; // 自身永远走网络

  // ---- 页面导航 ----
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await Promise.race([fetch(req), timeout(NAV_TIMEOUT)]);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cache = await caches.open(CACHE);
          const cached = (await cache.match(req)) ||
            (await cache.match(url.pathname.replace(/\/$/, '') || '/')) ||
            (await cache.match(OFFLINE_URL));
          if (cached) return cached;
          return new Response('现在没有网络，这个页面也没有离线副本。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // ---- 更新清单 / API ----
  if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (e) {
          const cached = await caches.match(req);
          return cached ||
            new Response('{}', { status: 504, headers: { 'Content-Type': 'application/json' } });
        }
      })(),
    );
    return;
  }

  // ---- 静态资源 ----
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (e) {
        return new Response('', { status: 504 });
      }
    })(),
  );
});
