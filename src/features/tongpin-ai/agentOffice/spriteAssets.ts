// Vite asset URLs for the office's pixel-art sprite sheets — see
// THIRD_PARTY_NOTICES.md for provenance (LimeZu "Modern Interiors", a pack
// Tongpin's owner separately purchased a full-version license for; see that
// file for the exact license terms). Every file here is a small crop
// produced by `scripts/agent-office/extract-limezu.py` — never the pack's own
// master sheets, which the license does not allow redistributing.
//
// Every import uses `?url&no-inline`, not just `?url`: on its own, `?url`
// only picks the *shape* of the import (a plain URL string, rather than a
// module Vite wires into the page for you) — Vite still runs its normal
// `assetsInlineLimit` check and is happy to make that "URL" a `data:` URI for
// a small file. Several of these sprites (native sizes as small as 16×16) are
// well under that default 4KB threshold, so without `no-inline` they would
// get base64-embedded straight into the office's lazy JS chunk instead of
// emitted as the separate, cacheable, content-hashed files this feature
// wants. This module has no side effects and touches neither Pixi nor the
// DOM, but it is imported only from spriteSheets.ts and the other scene
// modules that OfficeSceneController pulls in — all of which AgentOfficeView
// reaches through a dynamic `import()`, so these PNGs are fetched only inside
// that lazy "office" chunk, never from the main bundle.
//
// The one deliberate exception is portraits.ts, a separate, eager module for
// the tiny DOM-fallback portraits — see its own doc comment for why those
// must NOT follow this file's lazy-chunk convention.

import char1 from "./assets/limezu/characters/char_1.png?url&no-inline";
import char2 from "./assets/limezu/characters/char_2.png?url&no-inline";
import char3 from "./assets/limezu/characters/char_3.png?url&no-inline";
import char4 from "./assets/limezu/characters/char_4.png?url&no-inline";
import char5 from "./assets/limezu/characters/char_5.png?url&no-inline";
import char6 from "./assets/limezu/characters/char_6.png?url&no-inline";
import char7 from "./assets/limezu/characters/char_7.png?url&no-inline";
import floorUrl from "./assets/limezu/floor.png?url&no-inline";
import wallUrl from "./assets/limezu/wall.png?url&no-inline";
import baseboardUrl from "./assets/limezu/baseboard.png?url&no-inline";
import deskOffUrl from "./assets/limezu/desk_off.png?url&no-inline";
import deskOnAUrl from "./assets/limezu/desk_on_a.png?url&no-inline";
import deskOnBUrl from "./assets/limezu/desk_on_b.png?url&no-inline";
import chairUrl from "./assets/limezu/chair.png?url&no-inline";
import waterCoolerUrl from "./assets/limezu/water_cooler.png?url&no-inline";
import doorUrl from "./assets/limezu/door.png?url&no-inline";
import bookshelfAUrl from "./assets/limezu/bookshelf_a.png?url&no-inline";
import bookshelfBUrl from "./assets/limezu/bookshelf_b.png?url&no-inline";
import whiteboardUrl from "./assets/limezu/whiteboard.png?url&no-inline";
import plantBigUrl from "./assets/limezu/plant_big.png?url&no-inline";
import plantSmallUrl from "./assets/limezu/plant_small.png?url&no-inline";
import rugUrl from "./assets/limezu/rug.png?url&no-inline";
import coffeeUrl from "./assets/limezu/coffee.png?url&no-inline";
import clockUrl from "./assets/limezu/clock.png?url&no-inline";
import signboardUrl from "./assets/limezu/signboard.png?url&no-inline";

/** One 80×16 strip per character — see spriteFrameMath.ts for how each is
 *  sliced. Index 0-5 are worker-eligible, index 6 is the coordinator's
 *  exclusive sprite (see roster.ts). */
export const CHARACTER_SHEET_URLS: readonly string[] = [char1, char2, char3, char4, char5, char6, char7];

export const FLOOR_URL = floorUrl;
export const WALL_URL = wallUrl;
export const BASEBOARD_URL = baseboardUrl;

export const FURNITURE_URLS = {
  deskOff: deskOffUrl,
  deskOn: [deskOnAUrl, deskOnBUrl] as readonly string[],
  chair: chairUrl,
  waterCooler: waterCoolerUrl,
  door: doorUrl,
  bookshelfA: bookshelfAUrl,
  bookshelfB: bookshelfBUrl,
  whiteboard: whiteboardUrl,
  plantBig: plantBigUrl,
  plantSmall: plantSmallUrl,
  rug: rugUrl,
  coffee: coffeeUrl,
  clock: clockUrl,
  signboard: signboardUrl,
} as const;

/** Every URL this module owns, for one batched `Assets.load()` call. */
export const ALL_SPRITE_URLS: readonly string[] = [
  ...CHARACTER_SHEET_URLS,
  FLOOR_URL,
  WALL_URL,
  BASEBOARD_URL,
  FURNITURE_URLS.deskOff,
  ...FURNITURE_URLS.deskOn,
  FURNITURE_URLS.chair,
  FURNITURE_URLS.waterCooler,
  FURNITURE_URLS.door,
  FURNITURE_URLS.bookshelfA,
  FURNITURE_URLS.bookshelfB,
  FURNITURE_URLS.whiteboard,
  FURNITURE_URLS.plantBig,
  FURNITURE_URLS.plantSmall,
  FURNITURE_URLS.rug,
  FURNITURE_URLS.coffee,
  FURNITURE_URLS.clock,
  FURNITURE_URLS.signboard,
];
