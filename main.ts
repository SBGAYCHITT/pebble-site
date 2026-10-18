// Pebble Lunchar 官网 + 更新源（Deno Deploy）
//
// 两条职责故意放在同一个应用里：
//   1. 官网（静态页，服务端把版本号填进模板 —— 单一数据源）
//   2. 更新源（`/api/update/latest` / `/api/update/file/<name>`，**免登录**）
//
// 为什么不拆两个应用：客户端更新源必须是"用户没登录也能访问"的地址，
// 而官网上恰好就要显示版本号、大小、校验值。同一份 data/latest.json 喂两边，
// 就不会出现"官网写 5.1.0、更新源还停在 5.0.0"这种用户看得见但很难查的错。
//
// 零依赖：没有 import 任何 npm/jsr 包，只用 Deno 内置 API。

import {
  absolutizeFeed,
  checkSite,
  contentTypeOf,
  esc,
  type Feed,
  humanSize,
  isExeName,
  type Release,
  render,
  renderReleases,
  safeRelPath,
  validateFeed,
} from './lib.ts';

const PUBLIC = new URL('./public/', import.meta.url);
const DATA = new URL('./data/', import.meta.url);

/** 站点 origin。正常取请求头；放在反代后面时可用环境变量钉死 */
const ORIGIN_OVERRIDE = (Deno.env.get('SITE_ORIGIN') || '').replace(/\/+$/, '');

/** 允许推送的仓库（页面上所有 GitHub 链接都从这一处来） */
const REPO = 'SBGAYCHITT/PeBble_lunchar';
const REPO_URL = `https://github.com/${REPO}`;

/* ------------------------------------------------------------------ */
/* 读取数据                                                            */
/* ------------------------------------------------------------------ */

async function readText(url: URL): Promise<string | null> {
  try {
    return await Deno.readTextFile(url);
  } catch {
    return null;
  }
}

async function loadFeed(): Promise<{ check: ReturnType<typeof validateFeed>; raw: string }> {
  const txt = await readText(new URL('latest.json', DATA));
  if (txt == null) {
    return {
      check: { ok: false, errors: ['data/latest.json 不存在'], warnings: [], feed: emptyFeed() },
      raw: '',
    };
  }
  try {
    return { check: validateFeed(JSON.parse(txt)), raw: txt };
  } catch (e) {
    return {
      check: {
        ok: false,
        errors: ['data/latest.json 不是合法 JSON：' + (e instanceof Error ? e.message : String(e))],
        warnings: [],
        feed: emptyFeed(),
      },
      raw: txt,
    };
  }
}

function emptyFeed(): Feed {
  return { version: '0.0.0', notes: '', url: '', sha256: '', size: 0, publishedAt: '' };
}

async function loadReleases(): Promise<Release[]> {
  const txt = await readText(new URL('releases.json', DATA));
  if (!txt) return [];
  try {
    const v = JSON.parse(txt);
    const list = Array.isArray(v) ? v : Array.isArray(v?.releases) ? v.releases : [];
    return list
      .filter((r: unknown) => !!r && typeof r === 'object')
      .map((r: Record<string, unknown>) => ({
        version: String(r.version ?? ''),
        date: String(r.date ?? ''),
        title: String(r.title ?? ''),
        items: Array.isArray(r.items) ? r.items.map((x) => String(x)) : [],
      }))
      .filter((r: Release) => r.version);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 响应助手                                                            */
/* ------------------------------------------------------------------ */

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

/**
 * Deno Deploy 给每次部署注入的 ID。本地 `deno run` 时不存在。
 *
 * 存在的意义只有一个：回答「我明明推了，怎么还是旧页面」。
 * 拿线上 `x-build` 和本地提交比一下，就能分清是浏览器缓存、还是部署压根没触发。
 */
const DEPLOY_ID = Deno.env.get('DENO_DEPLOYMENT_ID') ?? '';

/** 给所有响应补上 `x-build`。拿不到部署 ID（本地跑）就原样返回。 */
function withBuild(res: Response): Response {
  if (!DEPLOY_ID) return res;
  try {
    const h = new Headers(res.headers);
    h.set('x-build', DEPLOY_ID.slice(0, 8));
    // 重新包一层而不是改 headers：从 fetch 拿到的 Headers 可能是只读的
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch {
    return res;
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'access-control-allow-origin': '*',
      ...SEC,
      ...extra,
    },
  });
}

function textResp(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SEC },
  });
}

function htmlResp(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 页面里嵌了版本号：缓存久了会出现"官网显示旧版本、下载到新版"的错位
      'cache-control': 'no-cache, must-revalidate',
      ...SEC,
    },
  });
}

/* ------------------------------------------------------------------ */
/* 页面渲染                                                            */
/* ------------------------------------------------------------------ */

async function renderPage(name: string, feed: Feed, releases: Release[], origin: string): Promise<Response> {
  const tpl = await readText(new URL(name, PUBLIC));
  if (tpl == null) return notFound();
  const body = render(tpl, {
    // 文档里的"更新源填这个地址"直接用当前域名拼 —— 换域名、换端口、本地跑，
    // 页面上写的都对，不需要手工改一处说明
    ORIGIN: esc(origin),
    VER: esc(feed.version.replace(/^v/i, '')),
    DATE: esc(feed.publishedAt || '—'),
    SIZE: esc(humanSize(feed.size)),
    SIZE_BYTES: esc(String(feed.size || 0)),
    SHA: esc(feed.sha256 || '（清单未提供校验值）'),
    SHA_OK: feed.sha256 ? '1' : '',
    URL: esc(feed.url || '#'),
    NOTES: esc(feed.notes || ''),
    REPO: esc(REPO_URL),
    RELEASES: renderReleases(releases, feed.version),
    RELEASES_COUNT: esc(String(releases.length)),
    YEAR: esc(String(new Date().getFullYear())),
  });
  return htmlResp(body);
}

function notFound(): Response {
  return htmlResp(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>404 · Pebble Lunchar</title>
<style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#1b2029;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{text-align:center;padding:24px}
h1{font-size:64px;margin:0;background:linear-gradient(135deg,#14c8b4,#0a7ff0);
-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:#6b7484}a{color:#0a7ff0}</style>
<main><h1>404</h1><p>这个页面不存在。</p><p><a href="/">回首页</a> · <a href="/docs">看文档</a></p></main></html>`,
    404,
  );
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function apiLatest(origin: string): Promise<Response> {
  const { check } = await loadFeed();
  if (!check.ok) {
    // 清单坏了要"坏得响亮"：客户端会把这个 error 显示给用户，比返回 200 + 空对象好查得多
    return json({ ok: false, error: '更新清单无效：' + check.errors.join('；') }, 500);
  }
  return json(absolutizeFeed(check.feed, origin));
}

async function apiFile(name: string, origin: string): Promise<Response> {
  if (!isExeName(name)) return textResp('bad name', 400);

  // 1) 本站托管：public/updates/<name>
  if (await exists(new URL('updates/' + name, PUBLIC))) {
    return serveFile(new URL('updates/' + name, PUBLIC), name);
  }

  // 2) 没托管就退到清单里的地址 —— 但只认**同名文件**。
  //    不加这个限制，任何人传 ?name=随便什么.exe 都能被 302 到别处，等于开放重定向。
  const { check } = await loadFeed();
  const target = absolutizeFeed(check.feed, origin).url;
  if (target && basename(target) === name && /^https?:\/\//i.test(target)) {
    return new Response(null, {
      status: 302,
      headers: { location: target, 'cache-control': 'no-store', ...SEC },
    });
  }
  return textResp('not found', 404);
}

function basename(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p.slice(p.lastIndexOf('/') + 1);
  } catch {
    return '';
  }
}

async function exists(url: URL): Promise<boolean> {
  try {
    const st = await Deno.stat(url);
    return st.isFile;
  } catch {
    return false;
  }
}

/**
 * 流式返回文件。
 *
 * 为什么不 `Deno.readFile` 一把读进来：安装包 79MB，部署实例内存上限 512MB，
 * 几个人同时下载就能把实例打 OOM。流式 + Content-Length 是唯一稳的做法，
 * 而且客户端正是靠 Content-Length 算进度的。
 */
async function serveFile(url: URL, name: string): Promise<Response> {
  try {
    const file = await Deno.open(url, { read: true });
    const st = await file.stat();
    return new Response(file.readable, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(st.size),
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'public, max-age=31536000, immutable',
        ...SEC,
      },
    });
  } catch {
    return textResp('read error', 500);
  }
}

async function apiHealth(origin: string, probe: boolean): Promise<Response> {
  const { check } = await loadFeed();
  const localUrl = new URL('updates/' + basename(check.feed.url || ''), PUBLIC);
  let localBytes: number | null = null;
  if (check.feed.url && isExeName(basename(check.feed.url))) {
    try {
      const st = await Deno.stat(localUrl);
      if (st.isFile) localBytes = st.size;
    } catch {
      localBytes = null;
    }
  }
  const site = checkSite(check, localBytes);

  const out: Record<string, unknown> = {
    ok: site.ok,
    feed: absolutizeFeed(check.feed, origin),
    warnings: check.warnings,
    checks: site.checks,
    serverTime: new Date().toISOString(),
  };

  if (probe && check.feed.url) {
    // 真去戳一下下载地址。这是唯一能提前发现"Release 里其实没上传 exe"的办法 ——
    // 清单本身永远是对的，错的是它指向的地方。
    const started = Date.now();
    try {
      const res = await fetch(absolutizeFeed(check.feed, origin).url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      const len = Number(res.headers.get('content-length') || 0);
      out.probe = {
        status: res.status,
        ok: res.ok,
        ms: Date.now() - started,
        contentLength: len || null,
        sizeMatches: len > 0 && check.feed.size > 0 ? len === check.feed.size : null,
      };
    } catch (e) {
      out.probe = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return json(out);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = ORIGIN_OVERRIDE || url.origin;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,HEAD,OPTIONS',
        'access-control-max-age': '86400',
      },
    });
  }
  if (method !== 'GET') return textResp('method not allowed', 405);

  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return textResp('bad path', 400);
  }

  /* ---------- 更新源（免登录，客户端直接打） ---------- */
  if (pathname === '/api/update/latest' || pathname === '/api/update/latest/') {
    return await apiLatest(origin);
  }
  if (pathname.startsWith('/api/update/file/')) {
    return await apiFile(pathname.slice('/api/update/file/'.length), origin);
  }
  if (pathname === '/api/update/health') {
    return await apiHealth(origin, url.searchParams.get('probe') === '1');
  }
  // 浏览器里直接打开就能看：这次线上跑的是哪个构建
  if (pathname === '/api/build') {
    return json({ deploymentId: DEPLOY_ID || null, servedAt: new Date().toISOString() });
  }
  if (pathname === '/api/releases') {
    return json(await loadReleases());
  }

  /* ---------- 页面 ---------- */
  if (pathname === '/') return await renderFresh('index.html', origin);
  if (pathname === '/changelog' || pathname === '/changelog.html') {
    return await renderFresh('changelog.html', origin);
  }
  if (pathname === '/docs' || pathname === '/docs.html') {
    return await renderFresh('docs.html', origin);
  }
  if (pathname === '/robots.txt') {
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, {
      headers: { 'content-type': 'text/plain; charset=utf-8', ...SEC },
    });
  }
  if (pathname === '/sitemap.xml') {
    const pages = ['/', '/changelog', '/docs'];
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}
</urlset>`;
    return new Response(body, {
      headers: { 'content-type': 'application/xml; charset=utf-8', ...SEC },
    });
  }

  /* ---------- 静态资源 ---------- */
  const rel = safeRelPath(pathname);
  if (!rel) return notFound();

  // 无扩展名时补 .html，让 /docs 这类地址在直接访问静态文件时也能命中
  const candidates = [rel];
  if (!/\.[A-Za-z0-9]+$/.test(rel)) candidates.push(rel + '.html');

  for (const cand of candidates) {
    const u = new URL(cand, PUBLIC);
    if (!(await exists(u))) continue;
    if (cand.endsWith('.html')) {
      // HTML 走模板替换（版本号在页面上），所以不能直接吐原文件
      return await renderFresh(cand, origin);
    }
    const res = await serveFile(u, cand);
    // 静态资源补上正确的 content-type（serveFile 是按安装包场景写的固定值）
    const ct = contentTypeOf(cand);
    if (ct !== 'application/octet-stream') {
      const h = new Headers(res.headers);
      h.set('content-type', ct);
      h.set('cache-control', 'public, max-age=300');
      return new Response(res.body, { status: 200, headers: h });
    }
    return res;
  }
  return notFound();
}

async function renderFresh(name: string, origin: string): Promise<Response> {
  const { check } = await loadFeed();
  const releases = await loadReleases();
  return await renderPage(name, check.feed, releases, origin);
}

Deno.serve(async (req: Request) => {
  try {
    // HEAD 单独处理：按 GET 算一遍，再把 body 丢掉。
    // 不这么做的话，安装包那条路会真的把 79MB 收进响应体 —— HEAD 的语义就是"只要头"，
    // 有的客户端（监控探针）看到带 body 会直接判协议错误。
    if (req.method.toUpperCase() === 'HEAD') {
      const r = await handle(new Request(req.url, { method: 'GET' }));
      try {
        await r.body?.cancel();
      } catch { /* 已经读完/已关闭都无所谓 */ }
      return withBuild(new Response(null, { status: r.status, headers: r.headers }));
    }
    return withBuild(await handle(req));
  } catch (e) {
    console.error('[site] unhandled', e);
    // 不打栈给外面看：这类信息对用户没意义，对攻击者倒是有用
    return withBuild(textResp('internal error', 500));
  }
});
