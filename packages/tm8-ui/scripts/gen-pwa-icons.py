#!/usr/bin/env python3
"""Cut every tm8 icon — favicon, PWA set, desktop app icon — from ONE vector.

THE SOURCE IS THE APP'S OWN MARK
--------------------------------
`public/tm8-mark.svg` is the Möbius ribbon 8 exactly as the app draws it:
`scripts/render-ribbon-svg.tsx` renders `RibbonMark` (standalone layout, rest
pose, brand ink) to static SVG. Until 2026-09-26 the icons were traced instead
from an old raster — an 8 with two eyes and arms — which the app itself had
stopped drawing when `BrandMark` moved to the ribbon, so the browser tab and
the dock showed a logo that appeared nowhere inside the product.

The SVG is 150 flat-shaded quads (the ribbon's pseudo-3D shading is baked into
each quad's fill). Pillow has no SVG renderer, but it does not need one: each
quad is drawn as a filled polygon at SUPERSAMPLE x, far-to-near in document
order (the component already painter-sorted them), then box-filtered down.
Each quad is also outlined in its own colour, exactly as the component strokes
it, to close the hairline seams between neighbours.

USAGE
    bun scripts/render-ribbon-svg.tsx          # only if RibbonMark changed
    python3 scripts/gen-pwa-icons.py           # writes every target below
    python3 scripts/gen-pwa-icons.py --check   # verify committed output is current

Requires Pillow (dev-only). `iconutil` (macOS) builds the .icns.
"""

from __future__ import annotations

import argparse
import io
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
UI = HERE.parent
PUBLIC = UI / 'public'
SOURCE = PUBLIC / 'tm8-mark.svg'
DESKTOP_BUILD = UI.parent.parent / 'apps' / 'desktop' / 'build'

# --pn-paper from src/styles/tokens.css. Launcher icons are opaque on purpose:
# a transparent "any" icon is composited onto a colour we do not control.
PAPER = (244, 242, 236, 255)
SUPERSAMPLE = 8


# ---------------------------------------------------------------------------
# 1 · the vector
# ---------------------------------------------------------------------------

POLY = re.compile(r'<polygon points="([^"]+)" fill="rgb\((\d+),(\d+),(\d+)\)" '
                  r'stroke="[^"]*" stroke-width="([\d.]+)"')


def load_quads(path: Path = SOURCE) -> list[tuple[list[tuple[float, float]], tuple[int, int, int], float]]:
    text = path.read_text()
    quads = []
    for pts, r, g, b, width in POLY.findall(text):
        xy = [tuple(float(v) for v in p.split(',')) for p in pts.split()]
        quads.append((xy, (int(r), int(g), int(b)), float(width)))
    if len(quads) < 3:
        raise SystemExit(f'{path}: expected the ribbon quads, found {len(quads)}')
    return quads


def bounds(quads) -> tuple[float, float, float, float]:
    xs = [x for q, _, _ in quads for x, _ in q]
    ys = [y for q, _, _ in quads for _, y in q]
    return min(xs), min(ys), max(xs), max(ys)


# ---------------------------------------------------------------------------
# 2 · rasterising
# ---------------------------------------------------------------------------

def draw_mark(quads, size: int, mark_frac: float, bg=(0, 0, 0, 0),
              plate: tuple[int, int] | None = None) -> Image.Image:
    """The ribbon centred in a `size` square, its LONGER side `mark_frac` of the
    area it sits in — the whole square, or a rounded `plate` (inset, radius)."""
    S = SUPERSAMPLE
    big = size * S
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    area = size
    if plate is not None:
        inset, radius = plate
        draw.rounded_rectangle([inset * S, inset * S, (size - inset) * S - 1, (size - inset) * S - 1],
                               radius=radius * S, fill=PAPER)
        area = size - 2 * inset
    elif bg[3]:
        draw.rectangle([0, 0, big, big], fill=bg)

    minx, miny, maxx, maxy = bounds(quads)
    w, h = maxx - minx, maxy - miny
    s = area * mark_frac / max(w, h) * S
    ox = (big - w * s) / 2 - minx * s
    oy = (big - h * s) / 2 - miny * s
    for pts, rgb, width in quads:
        xy = [(ox + x * s, oy + y * s) for x, y in pts]
        colour = (*rgb, 255)
        draw.polygon(xy, fill=colour)
        draw.line([*xy, xy[0]], fill=colour, width=max(1, round(width * s)), joint='curve')
    return img.resize((size, size), Image.Resampling.BOX)


# ---------------------------------------------------------------------------
# 3 · the targets
# ---------------------------------------------------------------------------
# "any" icons: 0.72 leaves the optical margin a launcher expects. Maskable: the
# mark must sit inside the 80%-diameter safe circle, and a tall mark's diagonal
# is what touches it, so 0.62. iOS masks apple-touch itself, hence opaque 0.66.

PWA_TARGETS = [
    ('icons/icon-192.png', 192, 0.72),
    ('icons/icon-512.png', 512, 0.72),
    ('icons/icon-maskable-512.png', 512, 0.62),
    ('icons/apple-touch-icon-180.png', 180, 0.66),
]

# macOS app icon grid (Big Sur+): an 824pt rounded plate, radius ~185, inside
# the 1024 canvas; the transparent margin is where the system shadow lands.
MAC_PLATE = (100, 185)
ICONSET = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def mac_icon(quads, px: int) -> Image.Image:
    # Drawn at 1024 and reduced, so every iconset size shares one geometry.
    return draw_mark(quads, 1024, 0.64, plate=MAC_PLATE).resize((px, px), Image.Resampling.LANCZOS)


def icns(quads) -> bytes:
    if shutil.which('iconutil') is None:
        raise SystemExit('iconutil not found — the .icns can only be built on macOS')
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'tm8.iconset'
        iconset.mkdir()
        for pt, scale in ICONSET:
            name = f'icon_{pt}x{pt}{"@2x" if scale == 2 else ""}.png'
            mac_icon(quads, pt * scale).save(iconset / name, 'PNG', optimize=True)
        out = Path(tmp) / 'icon.icns'
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)], check=True)
        return out.read_bytes()


def build() -> dict[Path, bytes]:
    quads = load_quads()
    out: dict[Path, bytes] = {}
    for name, size, frac in PWA_TARGETS:
        out[PUBLIC / name] = png(draw_mark(quads, size, frac, bg=PAPER))

    # Browser tab: transparent, filling its square — at 16px every pixel counts.
    fav = draw_mark(quads, 256, 0.96)
    buf = io.BytesIO()
    fav.save(buf, 'ICO', sizes=[(16, 16), (32, 32), (48, 48)])
    out[PUBLIC / 'favicon.ico'] = buf.getvalue()

    # The raster mark (precached; 128 tall like the asset it replaces).
    minx, miny, maxx, maxy = bounds(quads)
    tall = draw_mark(quads, 512, 1.0)
    bbox = tall.getbbox() or (0, 0, 512, 512)
    cropped = tall.crop(bbox)
    out[PUBLIC / 'tm8-mark.png'] = png(
        cropped.resize((max(1, round(cropped.width * 128 / cropped.height)), 128), Image.Resampling.LANCZOS))

    # Desktop: electron-builder reads build/icon.icns; the unpackaged dev app
    # sets build/icon.png on the dock itself (apps/desktop/src/main.cjs).
    out[DESKTOP_BUILD / 'icon.png'] = png(mac_icon(quads, 1024))
    out[DESKTOP_BUILD / 'icon.icns'] = icns(quads)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='fail if committed icons are stale')
    args = ap.parse_args()
    stale = []
    for path, data in build().items():
        rel = path.relative_to(UI.parent.parent)
        if args.check:
            # .icns bytes carry iconutil's own encoding; compare the PNGs only.
            if path.suffix != '.icns' and (not path.exists() or path.read_bytes() != data):
                stale.append(str(rel))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f'wrote {rel} ({len(data)} bytes)')
    if args.check:
        if stale:
            print('STALE (re-run without --check): ' + ', '.join(stale), file=sys.stderr)
            return 1
        print('icons are current')
    return 0


if __name__ == '__main__':
    sys.exit(main())
