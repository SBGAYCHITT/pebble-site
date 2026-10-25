#!/usr/bin/env node
// 静态化构建：把 Deno 服务端做的事（模板替换 + JSON 接口）在构建期一次性做完，
// 产出一个纯静态 dist/，好让 Cloudflare Pages / Netlify / 任何静态托管直接上。
//
// 为什么需要它：public/*.html 里有 30 多处 {{VER}} {{SIZE}} {{SHA}} {{RELEASES}}，
// 由 main.ts 在请求时填。直接丢静态托管，页面上就会露出 {{VER}} 这种花括号。
//
// v6 第一组（REC-01/02/03）的三件事都落在这里：
//   REC-01 缓存分级：静态资源加内容指纹 → /assets/xxx.<hash>.css → 一年 immutable
//   REC-02 预加载：HTML 注入 <link rel=preload as=style>，_headers 另发 Link 头供 103 使用
//   REC-03 构建确定性：CSS/HTML 安全压缩 + 产物自检，配合 .github/workflows/ci.yml
//
// v6 第三组（REC-06/07/08）：
//   REC-06 PWA：构建期生成 manifest.webmanifest 与带版本号的 sw.js，
//          预缓存清单跟着指纹一起变，改版就自动换 cache 名
//   REC-07 组件解耦：Header/Footer 抽成 src/partials/*.html，页面里只留
//          <!--@include:header-->；改导航只改一处
//   REC-08 Widget：/widgets 演示页 + Widget 契约（运行时在 public/widgets.js）
//
// 零依赖，只用 node 内置模块。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'public');
const SRC_EXTRA = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const REPO_URL = 'https://github.com/SBGAYCHITT/PeBble_lunchar';

// 最终域名：Pages 构建时注入 CF_PAGES_URL；本地构建用 SITE_ORIGIN 覆盖。
// 顺序很重要 —— 换了域名只要改这里，页面里的「更新源」说明自动跟着变。
const ORIGIN = (process.env.CF_PAGES_URL || process.env.SITE_ORIGIN || 'https://pebble-site-oea.pages.dev')
  .replace(/\/+$/, '');

/**
 * 需要加内容指纹的扩展名。
 *
 * 为什么必须指纹化：这些文件在 HTML 里是固定名字（/style.css），
 * 一旦对它们发 `max-age=31536000, immutable`，改了内容用户也永远看不到 ——
 * 浏览器连问都不会问一声。加指纹后「改内容 = 换名字」，才敢让它永久缓存。
 */
const FINGERPRINT_EXT = new Set(['.css', '.js', '.png', '.svg', '.jpg', '.jpeg', '.webp', '.ico', '.woff2']);

/* ---------------- 与 lib.ts 保持一致的纯函数 ---------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function humanSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function renderReleases(list, currentVersion) {
  if (!Array.isArray(list) || list.length === 0) {
    return '<p class="rel-empty">还没有记录版本历史。</p>';
  }
  return list
    .map((r) => {
      const isCurrent = String(r.version).replace(/^v/i, '') === currentVersion.replace(/^v/i, '');
      const items = (r.items || []).map((x) => `<li>${esc(x)}</li>`).join('');
      return `<article class="rel${isCurrent ? ' is-current' : ''}">
  <header class="rel-head">
    <h2>v${esc(String(r.version).replace(/^v/i, ''))}</h2>
    <time>${esc(r.date)}</time>
    ${isCurrent ? '<span class="tag">当前版本</span>' : ''}
  </header>
  <p class="rel-title">${esc(r.title)}</p>
  <ul class="rel-list">${items}</ul>
</article>`;
    })
    .join('\n');
}

/** 缺 key 就保留原样：忘了填要当场看得见，别渲染出一个空按钮 */
function render(tpl, vars) {
  return tpl.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (whole, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole),
  );
}

/* ---------------- 压缩 ---------------- */

/**
 * CSS 安全压缩：只做「删注释 + 收空白 + 去分隔符两侧空格」。
 * 不做变量重命名、不调换顺序 —— 那些才是真正会改坏样式的东西。
 * 本项目 CSS 里没有 content 带空格、也没有 data:url，所以这套是安全的。
 */
function minifyCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

/**
 * HTML 只删注释，**不动空白**。
 *
 * 原因：行内元素之间的换行本身就是一个空格（「好」字后面换行会把词分开），
 * 而 docs.html 里有 <pre><code> 的 JSON 示例，压掉缩进就毁了。
 * 删注释省下的字节已经够，不值得冒排版风险。
 */
function stripHtmlComments(src) {
  return src.replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
}

/* ---------------- 读数 + 校验 ---------------- */

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const feed = readJson(path.join(ROOT, 'data', 'latest.json'));
const releases = readJson(path.join(ROOT, 'data', 'releases.json'));

const problems = [];
if (!feed.version) problems.push('latest.json 缺 version');
if (!feed.url) problems.push('latest.json 缺 url');
if (!/^[0-9a-f]{64}$/i.test(String(feed.sha256 || ''))) {
  problems.push('latest.json 的 sha256 不是 64 位十六进制（客户端不会自动安装）');
}
if (!Number.isFinite(Number(feed.size)) || Number(feed.size) <= 0) {
  problems.push('latest.json 缺 size（下载进度条会没有底）');
}
if (problems.length) {
  console.error('\n构建中止，清单有问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/* ---------------- 清空输出目录 ---------------- */

try {
  fs.rmSync(DIST, { recursive: true, force: true });
} catch (e) {
  // Windows 上 dist/ 被别的进程占着（开着本地预览服务、编辑器索引）就删不掉。
  // 与其抛一串 shim 堆栈，不如直接说清楚怎么办。
  console.error(`\n清空 dist/ 失败：${e.message}`);
  console.error('如果有本地静态服务器或编辑器正打开这个目录，先关掉再构建。\n');
  process.exit(1);
}
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });

/* ---------------- 第一遍：指纹化静态资源 ---------------- */

/** 原相对路径（不含前导斜杠）→ 指纹后的站点路径 */
const assetMap = new Map();
/** 已指纹化的相对路径，第二遍拷贝时跳过 */
const fingerprinted = new Set();

function walk(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (e.name.endsWith('.html')) continue; // HTML 第二遍渲染
    const ext = path.extname(e.name).toLowerCase();
    if (!FINGERPRINT_EXT.has(ext)) continue;

    const buf = fs.readFileSync(abs);
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
    const stem = path.basename(e.name, ext);
    const out = `assets/${stem}.${hash}${ext}`;
    const body = ext === '.css' ? Buffer.from(minifyCss(buf.toString('utf8')), 'utf8') : buf;
    fs.writeFileSync(path.join(DIST, out), body);
    assetMap.set(rel, '/' + out);
    fingerprinted.add(rel);
  }
}
walk(SRC);

/* ---------------- 第二遍：渲染 HTML ---------------- */

const vars = {
  ORIGIN: esc(ORIGIN),
  VER: esc(feed.version.replace(/^v/i, '')),
  DATE: esc(feed.publishedAt || '—'),
  SIZE: esc(humanSize(feed.size)),
  SIZE_BYTES: esc(String(feed.size || 0)),
  SHA: esc(feed.sha256 || '（清单未提供校验值）'),
  SHA_OK: feed.sha256 ? '1' : '',
  URL: esc(feed.url || '#'),
  FILE: esc(path.basename(new URL(feed.url).pathname) || `Pebble-Launcher-${feed.version}.exe`),
  NOTES: esc(feed.notes || ''),
  REPO: esc(REPO_URL),
  RELEASES: renderReleases(releases, feed.version),
  RELEASES_COUNT: esc(String(releases.length)),
  YEAR: esc(String(new Date().getFullYear())),
};

/* ---------------- 组件包含（REC-07） ---------------- */

/**
 * `<!--@include:header-->` → src/partials/header.html
 *
 * 为什么要在构建期拼：四个页面的顶栏原来各写一份，改个链接得改四处，
 * 漏一处就出现「首页导航是新的、文档页还是旧的」。抽成 partial 后只有一个真相。
 * 不做运行时 JS 注入 —— 那会让导航晚一拍出现，还会被无 JS 的抓取器当成空页面。
 */
const PARTIALS = new Map();
const partialDir = path.join(SRC_EXTRA, 'partials');
if (fs.existsSync(partialDir)) {
  for (const f of fs.readdirSync(partialDir)) {
    if (f.endsWith('.html')) {
      PARTIALS.set(path.basename(f, '.html'), fs.readFileSync(path.join(partialDir, f), 'utf8'));
    }
  }
}

function includePartials(html) {
  return html.replace(/<!--\s*@include:([a-z0-9_-]+)\s*-->/gi, (whole, name) => {
    const part = PARTIALS.get(name);
    if (!part) {
      problems.push(`页面引用了不存在的 partial：${name}`);
      return whole;
    }
    return part;
  });
}

/** 把 HTML 里 `/style.css` 这类引用换成 `/assets/style.<hash>.css` */
function rewriteRefs(html) {
  return html.replace(/\b(href|src)="\/([^"?#>]+)([?#][^"]*)?"/g, (whole, attr, rel, suffix) => {
    const mapped = assetMap.get(rel);
    return mapped ? `${attr}="${mapped}${suffix || ''}"` : whole;
  });
}

/**
 * 在样式表之前插一条 preload。
 *
 * 作用有两层：浏览器能更早开始下 CSS；Cloudflare 的 Early Hints（103）
 * 也会读取资源提示，在 HTML 还没回完时先把 CSS 的连接建起来。
 */
function injectPreload(html) {
  const href = assetMap.get('style.css');
  if (!href || html.includes('rel="preload"')) return html;
  const tag = `<link rel="preload" as="style" href="${href}">`;
  const i = html.search(/<link[^>]+rel="stylesheet"/i);
  if (i < 0) return html;
  return html.slice(0, i) + tag + '\n  ' + html.slice(i);
}

/**
 * 注入 PWA 相关的三个标签（REC-06）。
 *
 * 只注入一次：如果页面自己已经写了 manifest，就不再插。
 * SW 的注册要等 load，避免和首屏资源抢带宽；注册失败静默，
 * 因为「不能安装到桌面」不该影响正常浏览。
 */
function injectPwa(html) {
  let out = html;

  if (!/rel="manifest"/i.test(out)) {
    // 注意：这里跑在 rewriteRefs 之后，所以图标路径要自己查 assetMap，
    // 不能直接写 /icons/xxx.png —— 那些文件已经被指纹化搬到 /assets/ 下了。
    const appleIcon = assetMap.get('icons/apple-touch-icon.png') || '/favicon.svg';
    const tags = [
      '<link rel="manifest" href="/manifest.webmanifest">',
      `<link rel="apple-touch-icon" href="${appleIcon}">`,
      '<meta name="apple-mobile-web-app-title" content="Pebble">',
    ].join('\n  ');
    out = out.replace(/<\/head>/i, `  ${tags}\n</head>`);
  }

  if (!out.includes('serviceWorker')) {
    const script = '<script>if("serviceWorker" in navigator){addEventListener("load",function(){' +
      'navigator.serviceWorker.register("/sw.js").catch(function(){})})}</script>';
    out = out.replace(/<\/body>/i, `${script}\n</body>`);
  }

  return out;
}

for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.html')) continue;
  const raw = fs.readFileSync(path.join(SRC, e.name), 'utf8');
  const body = stripHtmlComments(
    injectPreload(injectPwa(rewriteRefs(render(includePartials(raw), vars)))),
  );
  fs.writeFileSync(path.join(DIST, e.name), body);
}

/* ---------------- 其余文件原样拷贝 ---------------- */

function copyRest(dir, base = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      copyRest(abs, rel);
      continue;
    }
    if (e.name.endsWith('.html') || fingerprinted.has(rel)) continue;
    const out = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(abs, out);
  }
}
copyRest(SRC);

/* ---------------- PWA：manifest 与 Service Worker（REC-06） ---------------- */

/**
 * 图标为什么要指纹化：换 logo 时图标也得跟着换名字，
 * 否则浏览器/系统桌面会一直拿着旧的那张（manifest 里的 URL 没变）。
 */
const iconAny192 = assetMap.get('icons/icon-192.png');
const iconAny512 = assetMap.get('icons/icon-512.png');
const iconMask = assetMap.get('icons/icon-maskable-512.png');
if (!iconAny192 || !iconAny512 || !iconMask) {
  problems.push(
    'PWA 图标缺失：public/icons/ 下需要 icon-192.png、icon-512.png、icon-maskable-512.png（跑 tools/make-icons.py 生成）',
  );
}

const manifest = {
  name: 'Pebble Launcher',
  short_name: 'Pebble',
  description:
    'Windows 上的 Minecraft 启动器：一个文件、双击就能玩。存档能找回、世界能合并、卡了能查原因、Mod 一键装。',
  lang: 'zh-CN',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  categories: ['games', 'utilities'],
  icons: [
    { src: iconAny192, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: iconAny512, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: iconMask, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: '更新日志', short_name: '更新', url: '/changelog' },
    { name: '怎么用', short_name: '文档', url: '/docs' },
  ],
};
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

/**
 * 预缓存清单只放「首屏必需 + 离线时还想看」的东西。
 *
 * 有意不收进来的：icon-512（159 KB，只有安装时才用）、check-backend.*（排障工具，
 * 用的时候一定有网）、/data/*.json（更新信息必须联网拿最新的，缓存了反而误导）。
 * 这些走运行时的 cache-first / network-first，用到了自然就进缓存。
 */
const precache = [
  '/',
  '/docs',
  '/changelog',
  '/widgets',
  assetMap.get('style.css'),
  assetMap.get('motion.js'),
  assetMap.get('logo.png'),
  assetMap.get('favicon.svg'),
  assetMap.get('widgets.js'),
  '/manifest.webmanifest',
].filter(Boolean);

// 版本号 = 预缓存清单的指纹。任何一个资源改了名字（内容变了），cache 名就变，
// activate 时把旧的整套删掉 —— 不需要手动维护 CACHE_VERSION 常量。
const swVersion = crypto.createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
const swSource = fs.readFileSync(path.join(SRC_EXTRA, 'sw.js'), 'utf8');
fs.writeFileSync(
  path.join(DIST, 'sw.js'),
  // 必须 replaceAll：文件顶部注释里也提到这两个占位符，
  // 用 replace 只会换到注释那一处，真正的常量原样留着 —— 踩过。
  swSource.replaceAll('__VERSION__', swVersion).replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2)),
);

// 清单也要在站上有一份：客户端的更新源可以直指 /data/latest.json
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
for (const f of ['latest.json', 'releases.json']) {
  fs.copyFileSync(path.join(ROOT, 'data', f), path.join(DIST, 'data', f));
}

/* ---------------- Cloudflare 配置 ---------------- */

const styleHref = assetMap.get('style.css') || '/style.css';

// 静态站没有 main.ts 的路由，用重写把老接口路径接回静态文件。
// 200 = rewrite（地址栏不变），客户端代码不用改。
fs.writeFileSync(
  path.join(DIST, '_redirects'),
  [
    '/api/update/latest    /data/latest.json     200',
    '/api/update/latest/   /data/latest.json     200',
    '/api/releases         /data/releases.json   200',
    '',
  ].join('\n'),
);

/**
 * 缓存策略分三档，**用精确路径而不是 `/*` 兜底**。
 *
 * 踩过的坑：Cloudflare 对同一响应命中的多条 `_headers` 规则是「逗号拼接」而不是覆盖。
 * 曾经写成 `/*` 给 no-cache、`/assets/*` 给 immutable，结果 CSS 头变成
 * `no-cache, public, max-age=31536000, immutable` —— no-cache 依然生效，immutable 白设。
 * 所以这里只让 `/*` 管安全头（没人跟它抢），Cache-Control 全部按路径精确下发。
 *
 *   HTML           no-cache              每次回源确认，改版立刻可见
 *   /assets/*      一年 immutable        名字里带内容哈希，换名字才换内容
 *   /data/*、/api/* 60 秒                更新清单要快，但没必要每次穿透
 */
const headerLines = ['/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: no-referrer', ''];

// HTML 的规则按实际产物生成：新增页面不会漏掉缓存头。
// 无扩展路径（/docs）在 Pages 上是 rewrite 到 docs.html，匹配的是请求 URL，所以要一起写。
const htmlNames = fs.readdirSync(DIST).filter((f) => f.endsWith('.html')).sort();
for (const f of htmlNames) {
  const routes = ['/' + f];
  if (f === 'index.html') routes.push('/');
  else if (f !== '404.html') routes.push('/' + f.replace(/\.html$/, ''));
  for (const r of routes) {
    headerLines.push(r, '  Cache-Control: no-cache', `  Link: <${styleHref}>; rel=preload; as=style`, '');
  }
}

headerLines.push(
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  // SW 自己必须能更新：一旦发 immutable，浏览器会拿着旧脚本永远不换。
  // Service-Worker-Allowed 允许它接管更外层路径（这里就是根）。
  '/sw.js',
  '  Cache-Control: no-cache',
  '  Service-Worker-Allowed: /',
  '',
  '/manifest.webmanifest',
  '  Content-Type: application/manifest+json; charset=utf-8',
  '  Cache-Control: no-cache',
  '',
  '/data/*',
  '  Content-Type: application/json; charset=utf-8',
  '  Cache-Control: public, max-age=60',
  '',
  // /api/update/latest 是 _redirects 重写到 /data/*.json，匹配按请求路径算，得单独写
  '/api/*',
  '  Content-Type: application/json; charset=utf-8',
  '  Cache-Control: public, max-age=60',
  '',
  '/robots.txt',
  '  Cache-Control: public, max-age=3600',
  '',
  '/sitemap.xml',
  '  Cache-Control: public, max-age=3600',
  '',
  '',
);

fs.writeFileSync(path.join(DIST, '_headers'), headerLines.join('\n'));

fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);

fs.writeFileSync(
  path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${
    ['/', '/changelog', '/docs']
      .map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`)
      .join('\n')
  }
</urlset>`,
);

// 和 main.ts 的 404 保持同一份样式
fs.writeFileSync(
  path.join(DIST, '404.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>404 · Pebble Launcher</title>
<style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#1b2029;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{text-align:center;padding:24px}
h1{font-size:64px;margin:0;background:linear-gradient(135deg,#14c8b4,#0a7ff0);
-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:#6b7484}a{color:#0a7ff0}</style>
<main><h1>404</h1><p>这个页面不存在。</p><p><a href="/">回首页</a> · <a href="/docs">看文档</a></p></main></html>`,
);

/* ---------------- 自检：产物必须自洽 ---------------- */

const errors = [];

// 渲染阶段才发现的清单问题（partial 名字写错、PWA 图标没生成）在这里一起报。
if (problems.length) errors.push(...problems);

function scanHtml(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanHtml(p);
      continue;
    }
    if (!e.name.endsWith('.html')) continue;
    const body = fs.readFileSync(p, 'utf8');
    const where = path.relative(DIST, p);

    // 1) 模板占位符没填完
    const left = body.match(/\{\{[A-Z0-9_]+\}\}/g);
    if (left) errors.push(`${where}: 占位符没替换 —— ${[...new Set(left)].join(' ')}`);

    // 1b) partial 没展开（名字写错、或忘了先 walk）
    if (body.includes('@include:')) errors.push(`${where}: 还有没展开的 <!--@include:...-->`);

    // 1c) PWA 标签漏注入（404 是最后生成的极简页，不参与）
    if (where !== '404.html') {
      if (!body.includes('rel="manifest"')) errors.push(`${where}: 缺 <link rel="manifest">`);
      if (!body.includes('serviceWorker')) errors.push(`${where}: 缺 Service Worker 注册`);
    }

    // 2) 引用的本地文件不存在（漏拷 / 改名后忘记同步）
    for (const m of body.matchAll(/\b(?:href|src)="(\/[^"?#]+)"/g)) {
      const target = m[1];
      if (target.includes('{{')) continue;
      // /api/* 不是磁盘上的文件，由 _redirects 重写到 /data/*.json，不在这里校验
      if (target.startsWith('/api/')) continue;
      const abs = path.join(DIST, target.replace(/^\//, ''));
      if (!fs.existsSync(abs) && !fs.existsSync(abs + '.html')) {
        errors.push(`${where}: 引用了不存在的 ${target}`);
      }
    }
  }
}
scanHtml(DIST);

// 3) 指纹资源必须真的落盘
for (const [, href] of assetMap) {
  if (!fs.existsSync(path.join(DIST, href.replace(/^\//, '')))) errors.push(`缺少产物 ${href}`);
}

// 4) PWA 产物自洽：sw.js 占位符换干净了、manifest 里的图标真的存在
for (const f of ['manifest.webmanifest', 'sw.js']) {
  if (!fs.existsSync(path.join(DIST, f))) errors.push(`缺少产物 ${f}`);
}
const swOut = fs.existsSync(path.join(DIST, 'sw.js'))
  ? fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8')
  : '';
if (swOut.includes('__VERSION__') || swOut.includes('__PRECACHE__')) {
  errors.push('sw.js 里的 __VERSION__ / __PRECACHE__ 没替换');
}
if (fs.existsSync(path.join(DIST, 'manifest.webmanifest'))) {
  const mf = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
  for (const ic of mf.icons || []) {
    if (!ic.src || !fs.existsSync(path.join(DIST, ic.src.replace(/^\//, '')))) {
      errors.push(`manifest 里的图标不存在：${ic.src}`);
    }
  }
  if (!mf.icons || mf.icons.length < 3) errors.push('manifest 图标少于 3 个（缺 maskable）');
}

if (errors.length) {
  console.error('\n构建失败，产物不自洽：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

/* ---------------- 汇报 ---------------- */

console.log(`构建完成 → dist/  (${ORIGIN})`);
console.log(`  v${feed.version} · ${humanSize(feed.size)} · ${releases.length} 个版本记录`);
console.log(`  指纹资源 ${assetMap.size} 个 → /assets/（一年 immutable）`);
console.log(`  HTML no-cache；更新清单 60 秒`);
console.log(`  预加载 ${styleHref}`);
console.log(`  PWA：manifest + sw.js（cache pebble-${swVersion}，预缓存 ${precache.length} 项）`);
console.log(`  partials：${[...PARTIALS.keys()].join(', ') || '（无）'}`);
