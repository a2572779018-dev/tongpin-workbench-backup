#!/usr/bin/env python3
"""Rasterizes the office's wall signboard text into a small pixel-art PNG.

Renders with an OFL-licensed CJK pixel font (see FONT_PATH below and
THIRD_PARTY_NOTICES.md) at that font's native pixel size, then thresholds the
antialiased edges back to flat on/off pixels so the text stays crisp pixel
art rather than looking font-smoothed. Only this script's *output* PNG is
committed — never the font file itself (see THIRD_PARTY_NOTICES.md: the OFL
license terms are quoted there instead).

Run from anywhere:
    python3 scripts/agent-office/render-signboard.py
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))

# The owner's local copy of Cubic 11 (ACh-K/Cubic-11), an OFL-1.1 12px
# Simplified-Chinese pixel font vendored (under the same license) by the
# Fusion Pixel Font project. Chosen over the earlier 8px MisekiBitmap because
# 8px is too coarse a grid to render multi-stroke Simplified Chinese glyphs
# (责/频/etc.) legibly at any threshold — 12px is the smallest native pixel
# size that keeps every glyph in LINE_1/LINE_2 clean (see this feature's
# report for the glyph-coverage check). Not committed to the repo — see
# THIRD_PARTY_NOTICES.md for the license text and provenance.
FONT_PATH = os.environ.get(
    "SIGNBOARD_FONT_PATH",
    "/home/claude/tp/research/fonts/cubic-11/Cubic_11.ttf",
)
FONT_SIZE = 12

OUT_PATH = os.path.join(
    REPO_ROOT, "src", "features", "tongpin-ai", "agentOffice", "assets", "limezu", "signboard.png",
)

LINE_1 = "同频有限无责任公司"
LINE_2 = "作者Sam"

# LimeZu-palette-matching plaque: warm wood body + a darker walnut border and
# two small brass pins, so it reads as a hung sign rather than a UI label.
PLAQUE_FILL = (176, 120, 74, 255)
PLAQUE_BORDER = (92, 58, 34, 255)
PIN = (198, 168, 96, 255)
TEXT_FILL = (255, 244, 219, 255)
THRESHOLD = 110  # alpha cutoff that turns the font's antialiasing back into flat pixels


def render_line(text: str) -> Image.Image:
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    x0, y0, x1, y1 = font.getbbox(text)
    w, h = x1 - x0, y1 - y0
    # Render onto a generously padded scratch canvas (font metrics can report
    # a bbox slightly tighter than glyphs actually paint) then crop to content.
    scratch = Image.new("L", (w + 8, h + 8), 0)
    draw = ImageDraw.Draw(scratch)
    draw.text((4 - x0, 4 - y0), text, font=font, fill=255)
    bbox = scratch.getbbox()
    scratch = scratch.crop(bbox) if bbox else scratch
    # Threshold: keep this a flat-color pixel font, not font-smoothed grey.
    flat = scratch.point(lambda a: 255 if a >= THRESHOLD else 0)
    out = Image.new("RGBA", flat.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", flat.size, TEXT_FILL), (0, 0), flat)
    return out


def main() -> None:
    line1 = render_line(LINE_1)
    line2 = render_line(LINE_2)

    pad_x, pad_y, gap = 6, 5, 3
    content_w = max(line1.width, line2.width)
    content_h = line1.height + gap + line2.height
    plaque_w = content_w + pad_x * 2
    plaque_h = content_h + pad_y * 2 + 4  # +4 for the hanging pins along the top edge

    plaque = Image.new("RGBA", (plaque_w, plaque_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plaque)
    draw.rectangle((0, 4, plaque_w - 1, plaque_h - 1), fill=PLAQUE_FILL, outline=PLAQUE_BORDER, width=1)
    draw.rectangle((3, 0, 4, 5), fill=PIN)  # left hanging pin
    draw.rectangle((plaque_w - 5, 0, plaque_w - 4, 5), fill=PIN)  # right hanging pin

    x1 = (plaque_w - line1.width) // 2
    x2 = (plaque_w - line2.width) // 2
    y1 = 4 + pad_y
    y2 = y1 + line1.height + gap
    plaque.paste(line1, (x1, y1), line1)
    plaque.paste(line2, (x2, y2), line2)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    plaque.save(OUT_PATH)
    print(f"wrote {os.path.relpath(OUT_PATH, REPO_ROOT)}  {plaque.size[0]}x{plaque.size[1]}")


if __name__ == "__main__":
    main()
