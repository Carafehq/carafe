#!/usr/bin/env python3
"""Build Design/Carafe.icns: the Carafe mark (design 2a, "Coffee fill · bare") on the
design's dark app-icon tile (#17140f, radius 22/96), mark at 60/96 of the tile.

  python3 Design/make-icons.py            # writes Design/Carafe.icns

The mark is rendered by the app itself (`CarafeMenuBar --render-icons DIR`, the same
code that draws the status item) so the icon and the menu bar can never drift; this
script only composes the tile. Pillow + iconutil; no network.
"""
import os, subprocess, sys, tempfile
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TILE, RADIUS, MARK = 1024, round(1024 * 22 / 96), round(1024 * 60 / 96)

def app_binary():
    for rel in (".build/debug/CarafeMenuBar", ".build/release/CarafeMenuBar", "dist/Carafe.app/Contents/MacOS/CarafeMenuBar"):
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            return path
    sys.exit("build the app first (swift build)")

def main():
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([app_binary(), "--render-icons", tmp], check=True)
        mark = Image.open(os.path.join(tmp, "mark-full-640.png")).convert("RGBA")
        if mark.size != (MARK, MARK):
            mark = mark.resize((MARK, MARK), Image.LANCZOS)
        # The rendered mark is black with alpha; the dark tile wants it in paper white.
        white = Image.new("RGBA", mark.size, (246, 243, 238, 255)); white.putalpha(mark.getchannel("A"))
        tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
        ImageDraw.Draw(tile).rounded_rectangle((0, 0, TILE - 1, TILE - 1), radius=RADIUS, fill=(23, 20, 15, 255))
        offset = (TILE - MARK) // 2
        tile.alpha_composite(white, (offset, offset))
        tile.save(os.path.join(HERE, "app-icon-1024.png"))
        iconset = os.path.join(tmp, "Carafe.iconset"); os.mkdir(iconset)
        for pt in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = pt * scale
                name = f"icon_{pt}x{pt}" + ("@2x" if scale == 2 else "") + ".png"
                tile.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "Carafe.icns")], check=True)
    print("Design/Carafe.icns and Design/app-icon-1024.png written")

if __name__ == "__main__":
    main()
