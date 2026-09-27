// Vite asset URLs for the office's pixel-art sprite sheets — see
// THIRD_PARTY_NOTICES.md for provenance (Pixel Agents MIT / MetroCity CC0).
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

import char0 from "./assets/characters/char_0.png?url&no-inline";
import char1 from "./assets/characters/char_1.png?url&no-inline";
import char2 from "./assets/characters/char_2.png?url&no-inline";
import char3 from "./assets/characters/char_3.png?url&no-inline";
import char4 from "./assets/characters/char_4.png?url&no-inline";
import char5 from "./assets/characters/char_5.png?url&no-inline";
import floorUrl from "./assets/floors/floor_5.png?url&no-inline";
import wallUrl from "./assets/walls/wall_0.png?url&no-inline";
import deskFrontUrl from "./assets/furniture/DESK/DESK_FRONT.png?url&no-inline";
import pcFrontOffUrl from "./assets/furniture/PC/PC_FRONT_OFF.png?url&no-inline";
import pcFrontOn1Url from "./assets/furniture/PC/PC_FRONT_ON_1.png?url&no-inline";
import pcFrontOn2Url from "./assets/furniture/PC/PC_FRONT_ON_2.png?url&no-inline";
import pcFrontOn3Url from "./assets/furniture/PC/PC_FRONT_ON_3.png?url&no-inline";
import bookshelfUrl from "./assets/furniture/BOOKSHELF/BOOKSHELF.png?url&no-inline";
import whiteboardUrl from "./assets/furniture/WHITEBOARD/WHITEBOARD.png?url&no-inline";
import coffeeUrl from "./assets/furniture/COFFEE/COFFEE.png?url&no-inline";
import clockUrl from "./assets/furniture/CLOCK/CLOCK.png?url&no-inline";
import plantUrl from "./assets/furniture/PLANT/PLANT.png?url&no-inline";

/** One 112×96 sheet per character palette — see spriteFrameMath.ts for how each is sliced. */
export const CHARACTER_SHEET_URLS: readonly string[] = [char0, char1, char2, char3, char4, char5];

export const FLOOR_URL = floorUrl;
export const WALL_URL = wallUrl;

export const FURNITURE_URLS = {
  deskFront: deskFrontUrl,
  pcFrontOff: pcFrontOffUrl,
  pcFrontOn: [pcFrontOn1Url, pcFrontOn2Url, pcFrontOn3Url] as readonly string[],
  bookshelf: bookshelfUrl,
  whiteboard: whiteboardUrl,
  coffee: coffeeUrl,
  clock: clockUrl,
  plant: plantUrl,
} as const;

/** Every URL this module owns, for one batched `Assets.load()` call. */
export const ALL_SPRITE_URLS: readonly string[] = [
  ...CHARACTER_SHEET_URLS,
  FLOOR_URL,
  WALL_URL,
  FURNITURE_URLS.deskFront,
  FURNITURE_URLS.pcFrontOff,
  ...FURNITURE_URLS.pcFrontOn,
  FURNITURE_URLS.bookshelf,
  FURNITURE_URLS.whiteboard,
  FURNITURE_URLS.coffee,
  FURNITURE_URLS.clock,
  FURNITURE_URLS.plant,
];
