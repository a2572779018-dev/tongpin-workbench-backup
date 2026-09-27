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
# The *composed* per-theme sheets (as opposed to Theme_Sorter_Singles' one-
# file-per-sprite cutouts) — every purchased theme, including ones with no
# Singles folder of their own (e.g. "1_Generic", used below for the window),
# since Singles only exists for a handful of themes but every theme is part
# of the same purchased pack (see PACK_ROOT's own comment).
THEME_SORTER = os.path.join(INTERIORS, "Theme_Sorter")
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
    # Column 4 (of the sheet's 4 material columns) at y=32 — a calm sage
    # grey-green carpet with a very subtle mottled texture (no hard checker
    # contrast), matching the reference office's floor tone far better than
    # the previous warm wood-plank crop (column 1 @ y=192, still used for
    # deskless areas nowhere in this scene, so simply replaced outright) —
    # see the office's report for the full-sheet visual survey that found it.
    # Sampled 32x32 (2x2 tiles), tileable by design (that's what this sheet
    # is for).
    save(crop(floors, 192, 32, 32, 32), "floor.png")

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
    # Living_Room theme: potted plants.
    "plant_big.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 18),
    "plant_small.png": singles("2_Living_Room_Singles", "Living_Room_Singles", 15),
}


def build_furniture() -> None:
    for out_name, src_path in FURNITURE_SINGLES.items():
        im = load(src_path)
        save(im, out_name)


# desk_off/desk_on_{a,b}.png (above) are a single 16-native-wide "monitor
# module"; Desk.ts flanks it with two copies of this narrower slice to read
# as a ~2-tile-wide desk (per visual review against the reference office —
# see the feature's report), without needing a second whole furniture sprite.
# Conference_Hall_Singles_26.png is a plain desk surface with no monitor,
# same wood tones as desk_off/on (same furniture set) and, per direct pixel
# inspection, a flat horizontal color band with no left-right detail — so an
# 8px-wide slice of it (this crop, taking the visually-safe middle 8 of its
# 16, clear of its own left/right edge pixels) reads identically to the full
# sprite when placed beside the monitor module, tiled or not.
DESK_SIDE_SOURCE = os.path.join(SINGLES, "13_Conference_Hall_Singles", "Conference_Hall_Singles_26.png")


def build_desk_side() -> None:
    im = load(DESK_SIDE_SOURCE)
    save(crop(im, 4, 0, 8, 32), "desk_side.png")


# No window sprite exists in any of the 4 Theme_Sorter_Singles categories the
# owner purchased pre-cut (see the character/furniture sections' own PACK_ROOT
# comment) — but the *composed* "1_Generic" theme sheet (part of the same
# purchased pack, just never split into Singles files — see THEME_SORTER's own
# comment) turns out to have several, found by contact-sheeting it (see the
# feature's report). This one (a light-wood, 2-pane frame) reads well against
# this office's cream wall.
WINDOW_SOURCE = os.path.join(THEME_SORTER, "1_Generic_16x16.png")


def build_window() -> None:
    im = load(WINDOW_SOURCE)
    save(crop(im, 128, 688, 32, 32), "window.png")


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
# 16 wide x 32 tall (head+hair in the top ~half, collar/body/legs in the
# bottom half), laid out as 4 facing-direction columns (0=left profile,
# 1=back/away, 2=right profile, 3=front, each showing a partial or full face
# except column 1) repeated down the sheet as a walk cycle — confirmed by
# direct pixel-precise measurement (a labeled, gridded contact sheet zoomed
# until individual frame edges were unambiguous — see the feature's report),
# which is also what caught this script's own previous revision: it had
# (correctly) identified column 1 as face-free but then cropped only that
# 16-wide column's TOP 16 rows, discarding the bottom 16 (body/legs) —
# producing the "floating head behind a chair" bug the office's report
# describes. The fix is simply cropping the FULL 32-tall column instead.
#
# This office seats every employee facing their monitor (away from the
# camera) with the desk behind them and the screen visible above their head
# — see Desk.ts / EmployeeFigure.ts's doc comments for why a front-facing
# character can't work with this pack's desk art (the monitor fills the
# sprite's entire top half, leaving no gap for a face to show through) — so
# every named slot below reads column 1 (back-facing) at a different walk-
# cycle row, never a different column. This pack's premade characters have no
# dedicated "sit and type" / "phone call" animation (confirmed by surveying
# the sheet's full height — see the report): rows 0/32/64/128 are its own
# ordinary walk-cycle frames, differing only in subtle arm/leg position
# (mostly hidden behind the desk once seated) — genuinely different source
# pixels for typing_2/reading_1/reading_2 rather than duplicates of idle, but
# not a true distinct "action" pose. What actually reads as "busy" to the
# person watching is EmployeeFigure's own bob animation, the desk's monitor-
# flicker, and the activity bubble's own text/icon (search vs. result) — see
# those modules' doc comments. Row 96 is deliberately skipped: it's a
# shorter, differently-proportioned bust-only strip (a distinct emote/
# reaction row, not a walk frame), confirmed by the same visual survey.
CHAR_SHEET_IDS = [1, 2, 3, 4, 5, 6, 7]  # 1..6 = workers, 7 = coordinator (exclusive)
FRAME_W = 16
FRAME_H = 32
_BACK_X = 16  # column 1 (back-facing) — see the comment above.
CHAR_FRAME_SOURCES = [
    (_BACK_X, 0),  # idle
    (_BACK_X, 0),  # typing_1
    (_BACK_X, 32),  # typing_2
    (_BACK_X, 64),  # reading_1
    (_BACK_X, 128),  # reading_2
]
# Column 3 (front-facing), bottom 16px — the one crop that actually shows a
# full face, used ONLY for the DOM-fallback portrait (a recognizable face
# rather than the back of someone's head). The canvas scene and the fallback
# are allowed to differ here since the fallback has none of the desk-
# occlusion problem the canvas composition works around. Always 16x16 (its
# own fixed size, deliberately NOT FRAME_W/FRAME_H — those size the in-scene
# strip's full-body frame, a different crop entirely).
PORTRAIT_FRAME_SOURCE = (48, 16)
PORTRAIT_FRAME_SIZE = 16


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
        portrait = crop(sheet, *PORTRAIT_FRAME_SOURCE, PORTRAIT_FRAME_SIZE, PORTRAIT_FRAME_SIZE)
        save_portrait(portrait, f"portrait_{sheet_id}.png")


def main() -> None:
    build_room_shell()
    build_furniture()
    build_desk_side()
    build_window()
    build_animated_props()
    build_characters()
    print("\nDone. Commit only these small crops — never the source pack.")


if __name__ == "__main__":
    main()
