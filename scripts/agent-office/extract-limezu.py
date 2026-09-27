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
    # Column 1 (of the sheet's 4 material columns), the warm honey wood-plank
    # band at y=192 — a plain horizontal wood-grain texture (no busy
    # checker/medallion repeat) that reads as a calm "cozy office" floor at a
    # glance, per visual review of the full sheet (see the office's report).
    # Sampled 32x32 (2x2 tiles).
    save(crop(floors, 0, 192, 32, 32), "floor.png")

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
    # for the monitor-off / monitor-on states), a rolling office chair, a
    # water dispenser, a door.
    "desk_off.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 31),
    "desk_on_a.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 29),
    "desk_on_b.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 30),
    "chair.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 37),
    "water_cooler.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 45),
    "door.png": singles("13_Conference_Hall_Singles", "Conference_Hall_Singles", 63),
    # Classroom_and_Library theme: bookshelves + a standing chalkboard used as
    # this office's whiteboard/presentation board.
    "bookshelf_a.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 46),
    "bookshelf_b.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 58),
    "whiteboard.png": singles("5_Classroom_and_Library_Singles", "Classroom_and_Library_Singles", 39),
    # Living_Room theme: potted plants + a small diamond-motif rug tile (used
    # tiled, under the worker desk clusters — see seating.ts's DECOR_LAYOUT.rug
    # and sceneDraw.ts).
    "plant_big.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 18),
    "plant_small.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 15),
    "rug.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 28),
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
# sheet is 896x656, a modular character-generator template: every *pose* is
# 16 wide x 32 tall (head+hair in the top 16px, collar/body/legs in the
# bottom 16px), laid out as 4 facing-direction columns (0=left profile,
# 1=back/away, 2=right profile, 3=front, each showing a partial or full face
# except column 1) repeated down the sheet as a walk cycle — confirmed by
# direct visual inspection of all 4 columns' full 32px-tall poses side by
# side (see the office's report for that comparison), which is what caught
# an earlier version of this script reading column 0's *bottom* half and
# unintentionally showing a side-profile eye instead of a clean back-of-head.
#
# The in-scene strip crops only the TOP 16px of column 1 (pure hair/collar,
# identical across every walk-cycle row since only the legs move below the
# crop) — this office seats every employee facing their monitor (away from
# the camera) with the desk behind them and the screen visible above their
# head, see Desk.ts / EmployeeFigure.ts's doc comments for why a
# front-facing character can't work with this pack's desk art (the monitor
# fills the sprite's entire top half, leaving no gap for a face to show
# through). There is no second distinct back-of-head-only frame to pair it
# with for a typing/reading toggle (every column looks identical at this
# crop height until the collar line), so all 5 named slots below
# deliberately point at the same source rect rather than inventing a
# distinct pose that doesn't exist.
CHAR_SHEET_IDS = [1, 2, 3, 4, 5, 6, 7]  # 1..6 = workers, 7 = coordinator (exclusive)
FRAME_W = 16
FRAME_H = 16
# (x, y) top-left of each 16x16 frame within a Premade_Character_NN.png sheet.
_BACK_BUST = (16, 0)  # column 1 (back-facing), top 16px (hair/collar only)
CHAR_FRAME_SOURCES = [
    _BACK_BUST,  # idle
    _BACK_BUST,  # typing_1
    _BACK_BUST,  # typing_2
    _BACK_BUST,  # reading_1
    _BACK_BUST,  # reading_2
]
# Column 3 (front-facing), bottom 16px — the one crop that actually shows a
# full face, used ONLY for the DOM-fallback portrait (a recognizable face
# rather than the back of someone's head). The canvas scene and the fallback
# are allowed to differ here since the fallback has none of the desk-
# occlusion problem the canvas composition works around.
PORTRAIT_FRAME_SOURCE = (48, 16)


def build_characters() -> None:
    for sheet_id in CHAR_SHEET_IDS:
        src = os.path.join(CHARACTERS, f"Premade_Character_{sheet_id:02d}.png")
        sheet = load(src)
        strip = Image.new("RGBA", (FRAME_W * len(CHAR_FRAME_SOURCES), FRAME_H), (0, 0, 0, 0))
        for i, (fx, fy) in enumerate(CHAR_FRAME_SOURCES):
            frame = crop(sheet, fx, fy, FRAME_W, FRAME_H)
            strip.paste(frame, (i * FRAME_W, 0), frame)
        save(strip, "characters", f"char_{sheet_id}.png")

        # Eager DOM-fallback portrait — see PORTRAIT_FRAME_SOURCE above.
        portrait = crop(sheet, *PORTRAIT_FRAME_SOURCE, FRAME_W, FRAME_H)
        save_portrait(portrait, f"portrait_{sheet_id}.png")


def main() -> None:
    build_room_shell()
    build_furniture()
    build_animated_props()
    build_characters()
    print("\nDone. Commit only these small crops — never the source pack.")


if __name__ == "__main__":
    main()
