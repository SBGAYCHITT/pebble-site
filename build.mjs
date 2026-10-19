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
// 零依赖，只用 node 内置模块。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'public');
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

for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.html')) continue;
  const raw = fs.readFileSync(path.join(SRC, e.name), 'utf8');
  const body = stripHtmlComments(injectPreload(rewriteRefs(render(raw, vars))));
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
 * 缓存策略分三档：
 *   /*           no-cache            —— HTML 和一切没指纹的东西，每次回源确认
 *   /assets/*    一年 immutable       —— 名字里带内容哈希，改了就换名字，永久缓存是安全的
 *   /data/*      60 秒                —— 更新清单要快，但没必要每次穿透
 * 顺序有意义：Cloudflare 会合并命中的规则，后写的覆盖前面同名字段。
 */
fs.writeFileSync(
  path.join(DIST, '_headers'),
  [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Cache-Control: no-cache',
    `  Link: <${styleHref}>; rel=preload; as=style`,
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/data/*',
    '  Content-Type: application/json; charset=utf-8',
    '  Cache-Control: public, max-age=60',
    '',
    '',
  ].join('\n'),
);

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
