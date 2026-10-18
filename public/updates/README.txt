把安装包放到这个目录，就能由本站直接提供下载（不用走 GitHub）。

文件名必须与 data/latest.json 里的 url 末尾一致，例如：

  public/updates/Pebble-Lunchar-5.0.0.exe

之后把 latest.json 的 url 改成：

  "url": "/api/update/file/Pebble-Lunchar-5.0.0.exe"

以 / 开头的相对地址会按当前域名自动补全，换域名不用改数据。

注意：本站跑在 Deno Deploy 免费额度上，每月出网流量 20 GB。
79 MB 的包大约 260 次下载就会用光，然后整个站点会停。只在确实需要时启用自托管。
