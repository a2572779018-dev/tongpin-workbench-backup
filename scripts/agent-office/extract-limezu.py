#!/usr/bin/env python3
"""Crops the small set of LimeZu "Modern Interiors" sprites this office scene
actually uses out of the owner's purchased full-version pack, and writes only
those crops into the repo (never the master sheets — see THIRD_PARTY_NOTICES.md
and the license note at the top of spriteAssets.ts for why: the pack's license
allows editing/using the art in this project but not redistributing the asset
itself, so only these small necessary derivatives are committed).

Run from anywhere:
    python3 scripts/agent-office/extract-limezu.py

Requires Pillow. Reads from PACK_ROOT (the owner's local copy of the pack,
outside the repo/worktree entirely) and writes into OUT_DIR under the feature
folder. Re-running is idempotent — it always regenerates every output file
from the same source rects, so this script (not the PNGs it produces) is the
source of truth for exactly what was cropped from where.
"""
from __future__ import annotations

import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))

# The owner's local, purchased copy of LimeZu "Modern Interiors - RPG Tileset
# [16X16]" (full version, licensed 2026-09-27). Never committed to the repo —
# only this script's *output* crops are. Override with LIMEZU_PACK_ROOT if the
# pack lives somewhere else on this machine.
PACK_ROOT = os.environ.get(
    "LIMEZU_PACK_ROOT",
    "/home/claude/tp/research/limezu/mi",
)
INTERIORS = os.path.join(PACK_ROOT, "1_Interiors", "16x16")
SINGLES = os.path.join(INTERIORS, "Theme_Sorter_Singles")
CHARACTERS = os.path.join(PACK_ROOT, "2_Characters", "Character_Generator", "0_Premade_Characters", "16x16")
ANIMATED = os.path.join(PACK_ROOT, "3_Animated_objects", "16x16", "spritesheets")

OUT_DIR = os.path.join(
    REPO_ROOT, "src", "features", "tongpin-ai", "agentOffice", "assets", "limezu",
)
PORTRAIT_DIR = os.path.join(
    REPO_ROOT, "src", "features", "tongpin-ai", "agentOffice", "assets", "portraits",
)


def load(path: str) -> Image.Image:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"LimeZu source file not found: {path}\n(is LIMEZU_PACK_ROOT set correctly?)")
    return Image.open(path).convert("RGBA")


def crop(im: Image.Image, x: int, y: int, w: int, h: int) -> Image.Image:
    return im.crop((x, y, x + w, y + h))


def save(im: Image.Image, *parts: str) -> None:
    out_path = os.path.join(OUT_DIR, *parts)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im.save(out_path)
    print(f"wrote {os.path.relpath(out_path, REPO_ROOT)}  {im.size[0]}x{im.size[1]}")


def save_portrait(im: Image.Image, name: str) -> None:
    out_path = os.path.join(PORTRAIT_DIR, name)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im.save(out_path)
    print(f"wrote {os.path.relpath(out_path, REPO_ROOT)}  {im.size[0]}x{im.size[1]}")


# ── Room shell: small tileable swatches cropped from Room_Builder_subfiles ──
# (not the full modular corner/window auto-tile system — this office is one
# fixed rectangular room, so a single clean, seamless-enough material swatch
# per surface is all it needs; see the office's report for this scope note.)

def build_room_shell() -> None:
    subfiles = os.path.join(INTERIORS, "Room_Builder_subfiles")

    floors = load(os.path.join(subfiles, "Room_Builder_Floors_16x16.png"))
    # Column 2 (of the sheet's 4 material columns, each 48px/3 tiles wide,
    # starting at x=0/64/128/192), a plain cream checked-tile band. Sampled
    # 32x32 (2x2 tiles) well inside the column/band so no neighboring
    # material or the sheet's own row separators leak into the tile.
    save(crop(floors, 64, 32, 32, 32), "floor.png")

    walls = load(os.path.join(subfiles, "Room_Builder_Walls_16x16.png"))
    # Left sub-column of the sheet's first (cream/white) material group, one
    # cap-trim + flat-face band (each wall "unit" is a 32px-tall repeat) —
    # x=16..48 sits inside that sub-column, clear of the modular cross-shaped
    # doorway/corner cutout at its center.
    save(crop(walls, 16, 96, 32, 32), "wall.png")

    baseboards = load(os.path.join(subfiles, "Room_Builder_Baseboards_16x16.png"))
    # One warm-toned baseboard cap, the plain (non-two-tone) 16px-wide segment
    # from the sheet's "short caps" row.
    save(crop(baseboards, 0, 57, 16, 7), "baseboard.png")


# ── Furniture: LimeZu's own pre-cropped "Theme_Sorter_Singles" sprites ─────
# Each is already a single, tightly-bound item — these are whole-file copies
# (crop covering the entire source image), not slices out of a larger sheet.

def singles(theme_dir: str, prefix: str, index: int) -> str:
    return os.path.join(SINGLES, theme_dir, f"{prefix}_{index}.png")


FURNITURE_SINGLES = {
    # Conference_Hall theme: desk+monitor combos (blank/blue-screen pair used
    # for the monitor-off / monitor-on states), a water dispenser, a door.
    "desk_off.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 31),
    "desk_on_a.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 29),
    "desk_on_b.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 30),
    "water_cooler.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 45),
    "door.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 63),
    # Classroom_and_Library theme: bookshelves + a standing chalkboard used as
    # this office's whiteboard/presentation board.
    "bookshelf_a.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 46),
    "bookshelf_b.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 58),
    "whiteboard.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 39),
    # Living_Room theme: potted plants.
    "plant_big.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 18),
    "plant_small.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 15),
}


def build_furniture() -> None:
    for out_name, src_path in FURNITURE_SINGLES.items():
        im = load(src_path)
        save(im, out_name)


# ── Static props: single frame from 3_Animated_objects ────────────────────
# This office never animates its backdrop decor (see sceneDraw.ts's doc
# comment — only per-desk monitors and character poses ever animate, driven
# by OfficeSceneController's own paused-aware tick, not Pixi's global
# Ticker.shared that AnimatedSprite would default to), so only the first
# 16x32 frame of each multi-frame spritesheet is cropped — never the
# remaining in-between frames, which this scene has no code path that ever
# reads.

def build_animated_props() -> None:
    coffee = load(os.path.join(ANIMATED, "animated_coffee.png"))
    save(crop(coffee, 0, 0, 16, 32), "coffee.png")

    clock = load(os.path.join(ANIMATED, "animated_cuckoo_clock.png"))
    save(crop(clock, 0, 0, 16, 32), "clock.png")


# ── Characters: 6 workers + 1 coordinator-exclusive, from LimeZu's own      ─
# Premade_Character sheets (NOT the Munder Difflin TV-cast recolors). Each
# sheet is 896x656 with tightly packed 16x16 pose frames; the rows used here
# were identified by visual inspection (see the office's report), not from
# any bundled documentation (none ships with the pack). Every character's 5
# frames are re-packed into one small 80x16 strip in frame order
# [idle, working_1, working_2, phone_1, phone_2].

CHAR_SHEET_IDS = [1, 2, 3, 4, 5, 6, 7]  # 1..6 = workers, 7 = coordinator (exclusive)
FRAME_W = 16
FRAME_H = 16
# (x, y) top-left of each 16x16 frame within a Premade_Character_NN.png sheet.
CHAR_FRAME_SOURCES = [
    (0, 16),   # idle: first frame of the standing/idle-facing row
    (0, 272),  # working_1: first frame of the desk-leaning "working" row
    (16, 272), # working_2: second frame of the same row
    (0, 240),  # phone_1: first frame of the phone-holding row
    (16, 240), # phone_2: second frame of the same row
]
# No usable distinct "happy/done" frame exists on this sheet (the one
# candidate frame turned out to be a non-character prop, not a pose), so
# done/failed/cancelled/idle all reuse `idle` — the same way the previous
# Pixel Agents rig reused one resting frame for every non-animated pose.


def build_characters() -> None:
    for sheet_id in CHAR_SHEET_IDS:
        src = os.path.join(CHARACTERS, f"Premade_Character_{sheet_id:02d}.png")
        sheet = load(src)
        strip = Image.new("RGBA", (FRAME_W * len(CHAR_FRAME_SOURCES), FRAME_H), (0, 0, 0, 0))
        for i, (fx, fy) in enumerate(CHAR_FRAME_SOURCES):
            frame = crop(sheet, fx, fy, FRAME_W, FRAME_H)
            strip.paste(frame, (i * FRAME_W, 0), frame)
        save(strip, "characters", f"char_{sheet_id}.png")

        # Eager DOM-fallback portrait: just the idle frame, tiny on its own —
        # this one *is* meant to sit in the main bundle (see portraits.ts),
        # since the fallback list must render without ever loading the lazy
        # Pixi/office chunk that the rest of these crops live in.
        idle = crop(sheet, *CHAR_FRAME_SOURCES[0], FRAME_W, FRAME_H)
        save_portrait(idle, f"portrait_{sheet_id}.png")


def main() -> None:
    build_room_shell()
    build_furniture()
    build_animated_props()
    build_characters()
    print("\nDone. Commit only these small crops — never the source pack.")


if __name__ == "__main__":
    main()
