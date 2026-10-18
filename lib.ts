// 纯函数层：不碰 Deno 全局、不发请求、不读磁盘。
//
// 抽出来是为了能被 `deno test` 直接打穿 —— 校验、路径防穿越、渲染这几处
// 一旦写错，错法都是"看起来没事"：清单少个 sha256 客户端就静默不自动装，
// 路径少个判断就能读到 data/ 里的任意文件。这些东西必须能单独测。

/** 更新清单（客户端 updater.js 的 parseFeed 认的字段，一个不多一个不少） */
export interface Feed {
  version: string;
  notes: string;
  url: string;
  sha256: string;
  size: number;
  publishedAt: string;
}

/** 版本历史里的一条 */
export interface Release {
  version: string;
  date: string;
  title: string;
  items: string[];
}

export interface FeedCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  feed: Feed;
}

// 客户端 compareVersion 按点分段比，所以这里只拦"明显不是版本号"的输入。
// 允许 v 前缀、1~4 段、可选预发布后缀（beta.1），不给 5.0.0.0.0 这种糊弄过去。
const RE_VERSION = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?$/;
const RE_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * 校验并归一化更新清单。
 *
 * 分 errors / warnings 两级，是因为这两类错的后果完全不同：
 *   - errors：客户端会直接报错或拒绝，必须在上线前拦住
 *   - warnings：能用，但会**悄悄降级**（没 sha256 → 不自动安装；没 size → 进度条没底）
 * 这里刻意不把 warning 升成 error：小版本热修时先发出去比卡着更实际。
 */
export function validateFeed(raw: unknown): FeedCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const version = String(src.version ?? '').trim();
  if (!version) errors.push('缺少 version');
  else if (!RE_VERSION.test(version)) errors.push(`version 格式不对：${version}（应形如 5.0.0）`);

  const url = String(src.url ?? '').trim();
  if (!url) errors.push('缺少 url（客户端拿不到下载地址）');
  else if (!/^https?:\/\//i.test(url)) errors.push('url 必须是 http(s) 绝对地址');

  const sha256 = String(src.sha256 ?? '').trim().toLowerCase();
  if (!sha256) warnings.push('缺少 sha256：客户端不会自动安装，只会显示「打开下载页」');
  else if (!RE_SHA256.test(sha256)) errors.push('sha256 不是 64 位十六进制');

  const sizeRaw = Number(src.size);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
  if (!size) warnings.push('缺少 size：下载进度只能靠服务端 Content-Length');

  const publishedAt = String(src.publishedAt ?? '').trim();
  if (!publishedAt) warnings.push('缺少 publishedAt（只是展示用，可以后补）');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    feed: {
      version,
      notes: String(src.notes ?? ''),
      url,
      sha256,
      size,
      publishedAt,
    },
  };
}

/**
 * 把清单里以 `/` 开头的 url 补成绝对地址。
 *
 * 为什么要支持相对写法：站点换域名（免费子域名 → 自定义域名）时，
 * 写死绝对地址的那份清单就得跟着改一次，忘了改 = 客户端下到旧域名的死链。
 * 用相对地址 + 请求时的 origin 拼，换域名不用动数据。
 */
export function absolutizeFeed(feed: Feed, origin: string): Feed {
  if (!feed.url.startsWith('/')) return feed;
  return { ...feed, url: origin.replace(/\/+$/, '') + feed.url };
}

/**
 * 静态资源的路径归一化，返回 null 表示拒绝。
 *
 * 这是本站唯一的安全边界：`..%2f` 之类必须在这里死掉，不能靠"反正没有敏感文件"。
 * data/ 里那份清单虽然不敏感，但一个能穿越的读文件接口迟早会被拿去做别的事。
 */
export function safeRelPath(pathname: string): string | null {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return null; // 非法的 %xx
  }
  if (p.includes('\0')) return null;
  if (p.startsWith('/')) p = p.slice(1);
  if (p === '') p = 'index.html';
  if (p.endsWith('/')) p += 'index.html';

  // 反斜杠在 Windows 上是分隔符，在 URL 里却是个普通字符 —— 统一按分隔符处理再拦
  const parts = p.replace(/\\/g, '/').split('/');
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (seg.includes(':')) return null; // 盘符 / 备用数据流
  }
  if (!/^[A-Za-z0-9._\-/\u4e00-\u9fa5]+$/.test(parts.join('/'))) return null;
  return parts.join('/');
}

/** 安装包文件名白名单：只认字母数字点横线，且必须以 .exe 结尾 */
export function isExeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.exe$/.test(name);
}

export function contentTypeOf(rel: string): string {
  const ext = (rel.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'ico':
      return 'image/x-icon';
    case 'txt':
    case 'md':
      return 'text/plain; charset=utf-8';
    case 'exe':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

/** 字节数转人话。用十进制 MB：跟 Windows 资源管理器、GitHub 的口径一致 */
export function humanSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

/** HTML 转义。所有进模板的动态值都必须过这一步（包括版本号，它来自手写 JSON） */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把发布条目渲染成更新日志的 HTML。**内容全部转义**，包括列表项 */
export function renderReleases(list: Release[], currentVersion: string): string {
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

/**
 * 模板占位符替换。只认 `{{KEY}}`，缺 key 就保留原样 ——
 * 与其渲染出一个空按钮，不如让"忘了填"当场看得见。
 */
export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole;
  });
}

/**
 * 站点自己的健康检查。
 *
 * 存在的理由：这份清单是手写的，而写错的后果是**静默**的 ——
 * sha256 少一位，客户端不报错，只是永远只显示「打开下载页」；
 * url 指到没上传的 Release，用户点了才 404。所以要有一个地方能一眼看到。
 */
export function checkSite(
  feedCheck: FeedCheck,
  localBytes: number | null,
): { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } {
  const { feed, errors, warnings } = feedCheck;
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  checks.push({
    name: '清单可解析',
    ok: errors.length === 0,
    detail: errors.length ? errors.join('；') : `${feed.version} · ${feed.url}`,
  });

  checks.push({
    name: '版本号',
    ok: !!feed.version && RE_VERSION.test(feed.version),
    detail: feed.version || '缺失',
  });

  checks.push({
    name: 'sha256（决定能否自动安装）',
    ok: RE_SHA256.test(feed.sha256),
    detail: feed.sha256 ? feed.sha256.slice(0, 16) + '…' : '缺失 —— 客户端只会给下载链接',
  });

  checks.push({
    name: '下载地址',
    ok: /^https?:\/\//i.test(feed.url),
    detail: feed.url || '缺失',
  });

  if (localBytes != null) {
    const same = feed.size > 0 && localBytes === feed.size;
    checks.push({
      name: '本地安装包与 size 一致',
      ok: same,
      detail: same ? `${localBytes} 字节` : `清单写 ${feed.size || '未填'}，实际 ${localBytes} 字节`,
    });
  }

  const ok = checks.every((c) => c.ok) && warnings.length === 0;
  return { ok, checks };
}
