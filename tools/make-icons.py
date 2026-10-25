#!/usr/bin/env python3
"""从 public/logo.png（128×128，透明底）生成 PWA / iOS 图标。

为什么要单独生成而不是直接引用 logo.png：
- PWA 安装到桌面/手机时，浏览器按 manifest 里的 sizes 挑图，
  没有 192/512 就不给装（或者装出来是糊的）。
- maskable 图标会被系统裁成圆形/圆角矩形，图形必须留出 20% 安全边，
  否则 PB 的笔画会被切掉。
- iOS 的 apple-touch-icon 不吃透明底，透明区域会变成黑色，得自己铺白。

用法（改 logo 后重跑一次）：
  <venv>/python tools/make-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "logo.png"
OUT = ROOT / "public" / "icons"


def resize(im: Image.Image, size: int) -> Image.Image:
    # LANCZOS：128 → 512 是放大 4 倍，双线性会糊成一团，LANCZOS 边缘更干净
    return im.resize((size, size), Image.LANCZOS)


def on_canvas(im: Image.Image, canvas: int, inner: int, bg=None) -> Image.Image:
    """把图形缩到 inner 见方，居中贴到 canvas 画布上（可铺底色）。"""
    art = resize(im, inner)
    base = Image.new("RGBA", (canvas, canvas), bg or (0, 0, 0, 0))
    off = (canvas - inner) // 2
    base.paste(art, (off, off), art)
    return base


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    OUT.mkdir(parents=True, exist_ok=True)

    # 普通图标：全出血，系统自己加圆角
    resize(im, 192).save(OUT / "icon-192.png", optimize=True)
    resize(im, 512).save(OUT / "icon-512.png", optimize=True)

    # maskable：内容缩到 76%，四周留白，避免被裁掉
    on_canvas(im, 512, 388).save(OUT / "icon-maskable-512.png", optimize=True)

    # iOS：不吃透明底，铺白
    on_canvas(im, 180, 160, bg=(255, 255, 255, 255)).convert("RGB").save(
        OUT / "apple-touch-icon.png", optimize=True
    )

    for p in sorted(OUT.glob("*.png")):
        w, h = Image.open(p).size
        print(f"  {p.name:28} {w}×{h}  {p.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
