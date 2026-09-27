// Loads every LimeZu PNG this scene uses and slices each sheet into the
// individual Pixi Textures the rest of the scene draws with (see
// THIRD_PARTY_NOTICES.md for provenance). This is the one Pixi-dependent
// module between the pure asset-URL list (spriteAssets.ts) and pure slicing
// math (spriteFrameMath.ts) — it has no display objects of its own, only
// Textures, so it stays simple enough to not need its own test double: every
// caller either uses the real loader or (in tests) never constructs a real
// EmployeeFigure/Desk/backdrop in the first place (see
// OfficeSceneController.test.ts's fakes).
//
// AgentOfficeView awaits `loadOfficeTextures()` once, right after the Pixi
// Application initializes and before constructing OfficeSceneController;
// everything downstream (Desk, CharacterSprite, sceneDraw) then calls the
// synchronous `getOfficeTextures()`, which is safe precisely because that
// ordering is guaranteed.

import { Assets, Rectangle, Texture } from "pixi.js";
import {
  ALL_SPRITE_URLS,
  CHARACTER_SHEET_URLS,
  FLOOR_URL,
  FURNITURE_URLS,
  BASEBOARD_URL,
  WALL_URL,
} from "./spriteAssets";
import { CharacterFrame, characterFrameRect, type Rect } from "./spriteFrameMath";
import { CHARACTER_COUNT } from "./roster";

export interface CharacterTextureSet {
  /** Resting frame — shown whenever animationMapping.ts has no animated pair
   *  for the current pose (idle/done/failed/cancelled). */
  idle: Texture;
  typing: readonly [Texture, Texture];
  reading: readonly [Texture, Texture];
}

export interface OfficeTextures {
  /** Indexed by CharacterIndex (see roster.ts) — always CHARACTER_COUNT long. */
  characters: readonly CharacterTextureSet[];
  floor: Texture;
  wall: Texture;
  baseboard: Texture;
  deskOff: Texture;
  /** Alternated on a timer while a desk's monitor is "on" — see Desk.ts. */
  deskOn: readonly [Texture, Texture];
  /** Rolling office chair, drawn behind the character — see EmployeeFigure.ts. */
  chair: Texture;
  waterCooler: Texture;
  door: Texture;
  bookshelfA: Texture;
  bookshelfB: Texture;
  whiteboard: Texture;
  plantBig: Texture;
  plantSmall: Texture;
  /** Single static frame — see extract-limezu.py: this office never
   *  animates backdrop decor, so only one frame of the source spritesheet is
   *  ever cropped or loaded. */
  coffee: Texture;
  /** Single static frame — see the `coffee` doc comment above. */
  clock: Texture;
  signboard: Texture;
}

/** A new Texture cropped to `rect` of `sheet` — shares `sheet`'s GPU source
 *  (and therefore its scaleMode), so slicing never re-uploads pixels. */
function sub(sheet: Texture, rect: Rect): Texture {
  return new Texture({ source: sheet.source, frame: new Rectangle(rect.x, rect.y, rect.w, rect.h) });
}

/** Pixel art must sample nearest, never linear-blurred — see this feature's
 *  other sprites (e.g. EmployeeFigure's old bust texture) for the same
 *  convention. Setting this on the base texture also covers every sub-texture
 *  sliced from it (scaleMode lives on the shared source, not the frame). */
function nearest(texture: Texture): Texture {
  texture.source.scaleMode = "nearest";
  return texture;
}

let cache: OfficeTextures | null = null;
let loading: Promise<OfficeTextures> | null = null;

function buildCharacterSet(sheet: Texture): CharacterTextureSet {
  const frame = (f: CharacterFrame) => sub(sheet, characterFrameRect(f));
  return {
    idle: frame(CharacterFrame.IDLE),
    typing: [frame(CharacterFrame.TYPE_1), frame(CharacterFrame.TYPE_2)],
    reading: [frame(CharacterFrame.READ_1), frame(CharacterFrame.READ_2)],
  };
}

/** Loads and slices every sprite this scene uses. Memoized: later calls (e.g.
 *  a WebGL context rebuild while this module stays loaded, see glRecovery.ts)
 *  resolve immediately with the same textures instead of re-fetching. */
export function loadOfficeTextures(): Promise<OfficeTextures> {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;

  loading = Assets.load<Texture>(ALL_SPRITE_URLS as string[]).then((loaded) => {
    const characterSheets = CHARACTER_SHEET_URLS.map((url) => nearest(loaded[url]));
    if (characterSheets.length !== CHARACTER_COUNT) {
      throw new Error(`spriteSheets: expected ${CHARACTER_COUNT} character sheets, got ${characterSheets.length}`);
    }
    const characters = characterSheets.map(buildCharacterSet);

    const deskOn = FURNITURE_URLS.deskOn.map((url) => nearest(loaded[url])) as [Texture, Texture];

    const textures: OfficeTextures = {
      characters,
      floor: nearest(loaded[FLOOR_URL]),
      wall: nearest(loaded[WALL_URL]),
      baseboard: nearest(loaded[BASEBOARD_URL]),
      deskOff: nearest(loaded[FURNITURE_URLS.deskOff]),
      deskOn,
      chair: nearest(loaded[FURNITURE_URLS.chair]),
      waterCooler: nearest(loaded[FURNITURE_URLS.waterCooler]),
      door: nearest(loaded[FURNITURE_URLS.door]),
      bookshelfA: nearest(loaded[FURNITURE_URLS.bookshelfA]),
      bookshelfB: nearest(loaded[FURNITURE_URLS.bookshelfB]),
      whiteboard: nearest(loaded[FURNITURE_URLS.whiteboard]),
      plantBig: nearest(loaded[FURNITURE_URLS.plantBig]),
      plantSmall: nearest(loaded[FURNITURE_URLS.plantSmall]),
      coffee: nearest(loaded[FURNITURE_URLS.coffee]),
      clock: nearest(loaded[FURNITURE_URLS.clock]),
      signboard: nearest(loaded[FURNITURE_URLS.signboard]),
    };
    cache = textures;
    return textures;
  });

  return loading;
}

/** Synchronous accessor for code that only ever runs after
 *  `loadOfficeTextures()` has resolved. Throws otherwise — that would only
 *  happen if AgentOfficeView's load-then-construct ordering were broken. */
export function getOfficeTextures(): OfficeTextures {
  if (!cache) throw new Error("getOfficeTextures() called before loadOfficeTextures() resolved");
  return cache;
}
