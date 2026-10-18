# 部署与发版指引（Deno Deploy）

这份文档是给**你**（站长）看的，不是给访客看的。官网和更新源是同一个应用，
一次部署两件事一起生效。

站点目录：`D:\apps\2026-09-12-10-14-18\pebble-site`

```
pebble-site\
  main.ts            入口：路由 + 静态资源 + 更新源接口
  lib.ts             纯函数：清单校验、路径防穿越、模板渲染
  lib_test.ts        24 项单测（81 条断言）
  deno.json          deno task 定义
  data\
    latest.json      ★ 版本清单（官网显示的版本号和客户端读的是同一份）
    releases.json    ★ 更新日志（官网更新日志页）
  public\
    index.html      首页
    changelog.html  更新日志
    docs.html       文档
    style.css       样式（纯白 + 蓝绿像素渐变，跟启动器同一套颜色）
    favicon.svg
    updates\        放 exe 就能自托管下载（默认空）
```

---

## 一、先本地跑一遍（30 秒）

Deno 已经装在这台机器上了：`D:\tools\deno\deno.exe`

```bat
cd /d D:\apps\2026-09-12-10-14-18\pebble-site
D:\tools\deno\deno.exe task test
D:\tools\deno\deno.exe task check
D:\tools\deno\deno.exe task start
```

然后浏览器打开 `http://localhost:8000`，重点看两个地址：

- `http://localhost:8000/api/update/latest` —— 应该是一段 JSON
- `http://localhost:8000/api/update/health?probe=1` —— 自检，**`ok` 必须是 `true`**，
  而且 `probe.status` 应该是 200、`probe.sizeMatches` 应该是 `true`

> `probe=1` 会真的去 HEAD 一下下载地址。这是唯一能提前发现「Release 里其实没传 exe」的办法 ——
> 清单自己永远是对的，错的是它指向的地方。

---

## 二、让 `deno` 命令能用（只做一次）

**Deno 已经装好了**：`D:\tools\deno\deno.exe`（v2.9.7），不用再下载。
只差让命令能直接敲 —— 二选一：

**A. 只对当前这个 cmd 窗口生效（最快，推荐先用这个）**

```bat
set PATH=%PATH%;D:\tools\deno
deno --version
```

**B. 永久生效**（只改「用户变量」，不会动系统 PATH）

```bat
powershell -Command "[Environment]::SetEnvironmentVariable('Path',[Environment]::GetEnvironmentVariable('Path','User')+';D:\tools\deno','User')"
```

> 别用 `setx PATH "%PATH%;D:\tools\deno"` —— 那条会把系统 PATH 整段复制进用户 PATH，
> 还有 1024 字符截断的老坑，改坏了很难查。用上面 B 那条。
>
> 改完要**重开 cmd** 才生效。

验证：

```bat
deno --version
```

<details>
<summary>万一真需要重新下载（正常不用看）</summary>

国内直连 GitHub 会超时，走 npmmirror（Windows 10 起自带 `curl.exe` 和 `tar.exe`）：

```bat
cd /d D:\tools\deno
curl -L -o deno.zip https://registry.npmmirror.com/-/binary/deno/v2.9.7/deno-x86_64-pc-windows-msvc.zip
tar -xf deno.zip
```

如果解压报 `Can't unlink already-existing object: Permission denied`，
说明有 `deno.exe` 正在运行（比如本地预览服务）把人占住了：

```bat
taskkill /F /IM deno.exe
tar -xf deno.zip
```

实在不行就先 `del deno.exe` 再解压。**这个报错不影响已有的 exe**，
它是「新文件盖不上旧文件」，不是「旧文件坏了」。

</details>

---

## 三、第一次部署（选一条路）

### A. GitHub 自动部署（推荐，本机 jsr.io 不通就走这条）

**为什么推荐**：`deno deploy` 这个子命令本身是从 `jsr.io` 现拉的远程包，
大陆网络下会卡在 `Download jsr:@deno/deploy/meta.json` 十几分钟不动
（实测 `jsr.io` 主站 19.6 秒才响应，`meta.json` 直接 20 秒超时）。
GitHub 这条路完全绕开它 —— 实测 `github.com` 1.0 秒。

本地 git 仓库已经初始化好、提交身份也配好了，**只差推到远端**。

**1) 建仓库**

打开 https://github.com/new ，仓库名 `pebble-site`，
**不要**勾 "Add a README file" / ".gitignore" / "license"（勾了会多出一次冲突）。

**2) 推上去**

```bat
cd /d D:\apps\2026-09-12-10-14-18\pebble-site
git remote add origin https://github.com/SBGAYCHITT/pebble-site.git
git branch -M main
git push -u origin main
```

**3) 在 Deno Deploy 里连仓库**

打开 https://app.deno.com → **New App** → **Deploy from GitHub** →
授权 GitHub（第一次会弹窗）→ 选 `SBGAYCHITT/pebble-site`、分支 `main` →
应用名填 `pebble-lunchar` → Entrypoint 填 **`main.ts`** → Deploy。

> 站点代码是**零外部依赖**（只 import 自己的 `lib.ts`），所以构建阶段不会再碰
> jsr.io / npm，几秒就完。

**4) 拿域名**

形如 `https://pebble-lunchar.<你的组织>.deno.net`。

### B. 命令行部署（本机能访问 jsr.io 时才用）

```bat
cd /d D:\apps\2026-09-12-10-14-18\pebble-site
deno deploy --prod
```

第一次会依次问你：

1. **登录** —— 会打开浏览器。用 GitHub 账号授权即可（Deno Deploy 免费版够用）。
2. **选组织** —— 只有一个的话会自动选中；有多个就选你自己的那个。
3. **起名字** —— 建议 `pebble-lunchar`。这个名字会出现在域名里。

> ⚠️ 一定要带 `--prod`。不带的话部署出来的是一个**预览地址**，
> 每次部署都换 URL，启动器里的更新源第二天就失效了。

**把这个域名记下来**，后面三处都要用：

| 用在哪 | 填什么 |
|---|---|
| 启动器「设置 → 系统与更新 → 更新源」 | `https://pebble-lunchar.<组织>.deno.net/api/update/latest` |
| 启动器 `pebblecloud.js` 的默认后端（可选） | 只在你想把云存档也搬到这个站时才改，**默认不要动** |
| 首页下载按钮 | 自动跟着 `data/latest.json` 走，不用手改 |

部署完立刻自检：

```
https://pebble-lunchar.<组织>.deno.net/api/update/health?probe=1
```

`ok: true` 才算上线成功。

---

## 四、以后每次发版（照这个顺序，别乱）

顺序不能反：**先传文件，再改清单**。反过来会出现「先看到新版的用户下载到 404」。

### 1. 打包并算校验值

```bat
cd /d D:\apps\2026-09-12-10-14-18\pefebeb-lunchar
npm run dist

certutil -hashfile dist\Pebble-Lunchar-5.1.0.exe SHA256
certutil -hashfile dist\Pebble-Lunchar-5.1.0.exe MD5

for %I in (dist\Pebble-Lunchar-5.1.0.exe) do @echo %~zI
```

`certutil` 的输出带空格，粘进 JSON 前**把空格去掉、转小写**。
`for %I` 只在命令行直接敲时是单个 `%`；写成 `.bat` 文件要改成 `for %%I`。

### 2. 上传到 GitHub Releases

打 tag、传 exe。装好 GitHub CLI 的话：

```bat
gh release create v5.1.0 dist\Pebble-Lunchar-5.1.0.exe --title "v5.1.0" --notes-file ..\GITHUB-RELEASE-v5.1.0.md
```

没有 `gh` 就网页传：`https://github.com/SBGAYCHITT/PeBble_lunchar/releases/new`

传完把地址里的版本号换掉，**在浏览器打开一次**确认不是 404：

```
https://github.com/SBGAYCHITT/PeBble_lunchar/releases/download/v5.1.0/Pebble-Lunchar-5.1.0.exe
```

### 3. 改 `data/latest.json`

```json
{
  "version": "5.1.0",
  "notes": "一句话说清这版最要紧的改动",
  "url": "https://github.com/SBGAYCHITT/PeBble_lunchar/releases/download/v5.1.0/Pebble-Lunchar-5.1.0.exe",
  "sha256": "把 certutil 的结果去空格转小写粘这里",
  "size": 79032992,
  "publishedAt": "2026-10-20"
}
```

### 4. 在 `data/releases.json` **数组最前面**插一条

```json
{
  "version": "5.1.0",
  "date": "2026-10-20",
  "title": "一句话标题",
  "items": ["改了什么 1", "改了什么 2"]
}
```

数组第一项会被自动打上「当前版本」标记 —— 标记依据是 `version` 与 `latest.json` 一致，
所以这两处的版本号**必须写成一样的**。

### 5. 重新部署

**A 路线（GitHub 自动部署）—— 一条命令，推上去就自动构建**

```bat
cd /d D:\apps\2026-09-12-10-14-18\pebble-site
git add -A
git commit -m "v5.1.0"
git push
```

**B 路线（命令行）**

```bat
cd /d D:\apps\2026-09-12-10-14-18\pebble-site
deno deploy --prod --org <你的组织> --app pebble-lunchar
```

### 6. 自检

```
https://pebble-lunchar.<组织>.deno.net/api/update/health?probe=1
```

看到 `ok: true` 和 `probe.sizeMatches: true` 就完事了。
然后在启动器里点「检查更新」，应该能一路走到「下载并安装」。

---

## 五、安装包要不要放在本站？

两种做法，改一行就能切：

**A. 放 GitHub（默认，推荐）**

`data/latest.json` 的 `url` 填 GitHub Releases 直链。本站不占流量。

**B. 本站自托管（国内下载快，但额度有限）**

1. 把 exe 拷进 `pebble-site\public\updates\`
2. `url` 改成相对地址：

```json
"url": "/api/update/file/Pebble-Lunchar-5.1.0.exe"
```

以 `/` 开头会自动按当前域名补全，**换域名不用改数据**。

> `.gitignore` 里那条 `public/updates/*.exe` 只挡 git，**不挡部署** ——
> `deno deploy` 是把整个目录递归上传，只自动排除 `.git` 和 `node_modules`。
> 部署完用 `health` 看有没有「本地安装包与 size 一致」这一项通过，就说明包确实上去了。

代价：Deno Deploy 免费版每月出网流量 **20 GB**，79 MB 的包大约 **260 次下载**就会用光，
之后整个站点（包括首页和更新源）会停。Pro 版 200 GB，超出 $0.50/GB。

> 部署包里塞 79 MB 是允许的（上限 1 GB），但上传慢、每次部署都要重传，
> 而且部署包体积会一起计入限制。所以默认不这么干。

---

## 六、常见问题

**`deno deploy` 卡在 `Download ... jsr:@deno/deploy/meta.json`**
这不是网速慢，是 jsr.io 在大陆基本不通（实测主站 19.6 秒才响应、`meta.json` 20 秒超时）。
这个子命令本身要从 jsr.io 现拉，**没有离线办法**。改走第三节 A 路线（GitHub 集成），
或者给终端挂代理：`set HTTPS_PROXY=http://127.0.0.1:端口` 后重试。
判断是"卡死"还是"慢"：看 `%LOCALAPPDATA%\deno` 的体积有没有在涨，5 秒不动就是卡死。

**部署报 entrypoint 找不到**
`main.ts` 必须在站点根目录。`deno.json` 里没有指定入口时，CLI 按固定优先级找
`main.ts / mod.ts / server.ts` 这些名字，`main.ts` 排在最前。

**首页能打开，但 `/api/update/latest` 404**
说明这次被识别成了**静态站点**（只发文件、不跑 `main.ts`）。重新部署，选 **Web server /
Dynamic** 那一项，入口填 `main.ts`。判别方法：接口 404 但 `index.html` 正常，就是这种情况。

**改了 `data/*.json` 但线上没变**
忘了重新部署。`data/` 是随代码一起上传的，不是运行时从别处拉的。

**`/api/update/latest` 返回 500**
说明清单本身有错，响应里的 `error` 会写清楚是哪一项。最常犯的是 sha256 少一位、
url 写成了相对路径却忘了加 `/`。

**健康检查里 sha256 那项是红的**
客户端会因此**不自动安装**，只显示「打开下载页」。这不是 bug，是设计：不装验不了的文件。

**首页显示 404 / 部署成功但打不开**
确认用的是生产域名（部署时带了 `--prod`），而不是预览地址。

**想换域名**
在 Deno Deploy 控制台给这个 app 绑自定义域名。代码不用改：
文档页里的更新源地址是拿请求的 origin 拼的，`url` 用 `/` 开头也会自动补全。

**回滚**
控制台 → 该项目 → Deployments → 找到上一个正常版本 → Promote to production。
比改代码快，适合「发完发现清单写错了」这种场景。

---

## 七、以后想加 beta 通道

现在是「一个清单 = 一个版本」。要分稳定版 / 测试版，最小的做法是：

1. 复制一份 `data/latest-beta.json`
2. `main.ts` 里 `apiLatest` 读 `url.searchParams.get('channel')`，等于 `beta` 就换文件
3. 客户端 `checkUpdate` 已是「喂什么地址查什么」，把地址末尾加 `?channel=beta` 就行

客户端**不需要改代码** —— 它本来就只认一个 URL。
