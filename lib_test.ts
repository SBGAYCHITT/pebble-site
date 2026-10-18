// lib.ts 的单测。零依赖：没有从 jsr/std 拉断言库 ——
// 这个站点本身就要"一条命令能跑、断网也能测"，多一个远程依赖就多一个失败点。

import {
  absolutizeFeed,
  checkSite,
  contentTypeOf,
  esc,
  humanSize,
  isExeName,
  render,
  renderReleases,
  safeRelPath,
  validateFeed,
} from './lib.ts';

let passed = 0;

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error('断言失败：' + msg);
  passed++;
}

function eq<T>(actual: T, expect: T, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expect);
  if (a !== b) throw new Error(`断言失败：${msg}\n  实际 ${a}\n  期望 ${b}`);
  passed++;
}

const GOOD = {
  version: '5.0.0',
  notes: '测试',
  url: 'https://example.com/Pebble-Lunchar-5.0.0.exe',
  sha256: 'f6dde1f35c651bea12649ffef8f019048601a39d588a6d9a037fe338aa0ad6d0',
  size: 79032992,
  publishedAt: '2026-10-17',
};

/* ---------------- validateFeed ---------------- */

Deno.test('validateFeed：完整清单无错无警告', () => {
  const r = validateFeed(GOOD);
  ok(r.ok, '应通过');
  eq(r.errors, [], 'errors 应为空');
  eq(r.warnings, [], 'warnings 应为空');
  eq(r.feed.size, 79032992, 'size 应保留');
});

Deno.test('validateFeed：v 前缀与小版本号', () => {
  ok(validateFeed({ ...GOOD, version: 'v5.0.0' }).ok, 'v 前缀应接受');
  ok(validateFeed({ ...GOOD, version: '5.1' }).ok, '两段版本号应接受');
  ok(validateFeed({ ...GOOD, version: '5.1.0-beta.1' }).ok, '预发布后缀应接受');
});

Deno.test('validateFeed：version 缺失或乱写是 error', () => {
  const a = validateFeed({ ...GOOD, version: '' });
  ok(!a.ok, '空 version 应拒绝');
  ok(a.errors.some((x) => x.includes('version')), '错误里应提到 version');

  const b = validateFeed({ ...GOOD, version: '最新版' });
  ok(!b.ok, '非数字 version 应拒绝');

  const c = validateFeed({ ...GOOD, version: '1.2.3.4.5' });
  ok(!c.ok, '超过四段应拒绝');
});

Deno.test('validateFeed：缺 sha256 只是 warning（客户端降级，不是报错）', () => {
  const r = validateFeed({ ...GOOD, sha256: undefined });
  ok(r.ok, '不应变成 error —— 少一步比装个验不了的文件好');
  ok(r.warnings.some((x) => x.includes('sha256')), '应提示 sha256 缺失');
});

Deno.test('validateFeed：sha256 大写归一成小写', () => {
  const r = validateFeed({ ...GOOD, sha256: GOOD.sha256.toUpperCase() });
  ok(r.ok, '大写应接受');
  eq(r.feed.sha256, GOOD.sha256, '应转小写');
});

Deno.test('validateFeed：sha256 长度不对是 error', () => {
  const r = validateFeed({ ...GOOD, sha256: GOOD.sha256.slice(0, 40) });
  ok(!r.ok, '短 sha256 应拒绝');
});

Deno.test('validateFeed：url 必须是 http(s)', () => {
  ok(!validateFeed({ ...GOOD, url: 'ftp://x/y.exe' }).ok, 'ftp 应拒绝');
  ok(!validateFeed({ ...GOOD, url: '' }).ok, '空 url 应拒绝');
  ok(!validateFeed({ ...GOOD, url: 'Pebble-Lunchar.exe' }).ok, '裸文件名应拒绝');
});

Deno.test('validateFeed：size 允许字符串，非法值退回 0 + 警告', () => {
  eq(validateFeed({ ...GOOD, size: '79032992' }).feed.size, 79032992, '字符串数字应转成数字');
  const bad = validateFeed({ ...GOOD, size: -5 });
  eq(bad.feed.size, 0, '负数应退回 0');
  ok(bad.warnings.some((x) => x.includes('size')), '应提示 size 缺失');
});

Deno.test('validateFeed：非对象输入不崩', () => {
  for (const v of [null, undefined, 42, 'x', []]) {
    const r = validateFeed(v);
    ok(!r.ok, `输入 ${JSON.stringify(v)} 应被拒绝`);
  }
});

/* ---------------- absolutizeFeed ---------------- */

Deno.test('absolutizeFeed：相对地址补 origin，绝对地址不动', () => {
  const rel = absolutizeFeed({ ...GOOD, url: '/api/update/file/a.exe' }, 'https://x.deno.net');
  eq(rel.url, 'https://x.deno.net/api/update/file/a.exe', '应补全');

  const abs = absolutizeFeed(GOOD, 'https://x.deno.net');
  eq(abs.url, GOOD.url, '绝对地址不应改');

  const slash = absolutizeFeed({ ...GOOD, url: '/a.exe' }, 'https://x.deno.net/');
  eq(slash.url, 'https://x.deno.net/a.exe', 'origin 末尾斜杠不应拼出 //');
});

/* ---------------- safeRelPath ---------------- */

Deno.test('safeRelPath：正常路径', () => {
  eq(safeRelPath('/'), 'index.html', '根路径');
  eq(safeRelPath('/style.css'), 'style.css', '相对化');
  eq(safeRelPath('/docs'), 'docs', '无扩展名');
  eq(safeRelPath('/assets/a/b.png'), 'assets/a/b.png', '子目录');
  eq(safeRelPath('/updates'), 'updates', '目录本身');
});

Deno.test('safeRelPath：路径穿越全部拒绝', () => {
  const bad = [
    '/../etc/passwd',
    '/data/latest.json/../../secret',
    '/%2e%2e/secret',
    '/a/%2E%2E%2Fb',
    '/..%5c..%5cwin.ini',
    '/a\\..\\b',
    '/C:/Windows/win.ini',
    '/a%00b',
    '/%zz',
  ];
  for (const p of bad) {
    eq(safeRelPath(p), null, `应拒绝 ${p}`);
  }
});

/* ---------------- isExeName ---------------- */

Deno.test('isExeName：只认 .exe 且字符受限', () => {
  ok(isExeName('Pebble-Lunchar-5.0.0.exe'), '正常文件名应通过');
  ok(isExeName('a.exe'), '最短文件名应通过');
  ok(!isExeName('a.zip'), '非 exe 应拒绝');
  ok(!isExeName('../a.exe'), '带路径应拒绝');
  ok(!isExeName('a b.exe'), '空格应拒绝');
  ok(!isExeName('.exe'), '只有扩展名应拒绝');
});

/* ---------------- 展示层 ---------------- */

Deno.test('humanSize：十进制口径', () => {
  eq(humanSize(79032992), '79.0 MB', '79MB');
  eq(humanSize(999), '999 B', '小于 1KB');
  eq(humanSize(1500), '1.5 KB', 'KB');
  eq(humanSize(0), '—', '0 显示占位');
  eq(humanSize(Number.NaN), '—', 'NaN 显示占位');
});

Deno.test('esc：HTML 特殊字符', () => {
  eq(esc('<script>'), '&lt;script&gt;', '尖括号');
  eq(esc('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;', '引号与 &');
  eq(esc(undefined), '', 'undefined 变空串');
});

Deno.test('contentTypeOf：关键类型', () => {
  eq(contentTypeOf('a.html'), 'text/html; charset=utf-8', 'html');
  eq(contentTypeOf('a.css'), 'text/css; charset=utf-8', 'css');
  eq(contentTypeOf('a.svg'), 'image/svg+xml', 'svg');
  eq(contentTypeOf('a.exe'), 'application/octet-stream', 'exe');
  eq(contentTypeOf('a.unknown'), 'application/octet-stream', '未知类型');
});

Deno.test('render：只替换已知占位符，未知保留原样', () => {
  eq(render('v{{VER}} {{NOPE}}', { VER: '5.0.0' }), 'v5.0.0 {{NOPE}}', '未知占位符应保留');
  eq(render('{{A}}{{A}}', { A: 'x' }), 'xx', '重复占位符都应替换');
  eq(render('{{ A }}', { A: 'x' }), '{{ A }}', '带空格的不算占位符');
});

Deno.test('renderReleases：当前版本打标、内容全部转义', () => {
  const html = renderReleases([
    { version: '5.0.0', date: '2026-10-17', title: '<b>标题</b>', items: ['<img src=x>'] },
    { version: '4.4.0', date: '2026-10-15', title: '旧版', items: [] },
  ], '5.0.0');

  ok(html.includes('当前版本'), '当前版本应有标记');
  ok(html.includes('&lt;b&gt;标题&lt;/b&gt;'), '标题应转义');
  ok(html.includes('&lt;img src=x&gt;'), '列表项应转义');
  ok(!html.includes('<img src=x>'), '不应有未转义的标签');
  eq((html.match(/is-current/g) || []).length, 1, '只有一条当前版本');
});

Deno.test('renderReleases：空列表给占位而不是空白', () => {
  ok(renderReleases([], '5.0.0').includes('还没有记录'), '应有占位文案');
});

/* ---------------- checkSite ---------------- */

Deno.test('checkSite：健康清单全绿', () => {
  const r = checkSite(validateFeed(GOOD), 79032992);
  ok(r.ok, '应全绿');
  ok(r.checks.every((c) => c.ok), '每项都应通过');
});

Deno.test('checkSite：缺 sha256 应判不健康', () => {
  const r = checkSite(validateFeed({ ...GOOD, sha256: '' }), 79032992);
  ok(!r.ok, '缺校验值不应算健康');
  ok(r.checks.some((c) => c.name.includes('sha256') && !c.ok), 'sha256 项应标红');
});

Deno.test('checkSite：本地包大小对不上要报出来', () => {
  const r = checkSite(validateFeed(GOOD), 79032993);
  ok(!r.ok, '大小不一致不应算健康');
  ok(r.checks.some((c) => c.name.includes('size') && !c.ok), '应有一条 size 检查失败');
});

Deno.test('checkSite：本站托管（url 无 size 字段）不误报', () => {
  // 自托管时清单仍应有 size；这里验证"没有本地文件"时不额外加检查项
  const r = checkSite(validateFeed(GOOD), null);
  ok(r.ok, '没有本地文件时不应因此判坏');
  ok(!r.checks.some((c) => c.name.includes('本地安装包')), '不应凭空加本地检查');
});

Deno.test('全部用例数量', () => {
  ok(passed > 30, `断言数 ${passed}，应超过 30`);
  console.log(`lib_test: ${passed} 条断言通过`);
});
