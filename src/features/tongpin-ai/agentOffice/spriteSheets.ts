// Loads every Pixel Agents / MetroCity PNG this scene uses and slices each
// sheet into the individual Pixi Textures the rest of the scene draws with
// (see THIRD_PARTY_NOTICES.md for provenance). This is the one Pixi-dependent
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
  WALL_URL,
} from "./spriteAssets";
import {
  CharacterFrame,
  CharacterRow,
  characterFrameRect,
  type Rect,
  WALL_BITMASK_COUNT,
  wallPieceRect,
} from "./spriteFrameMath";
import { CHARACTER_COUNT } from "./roster";

export interface CharacterTextureSet {
  /** Resting frame (WALK_2) — shown whenever animationMapping.ts has no
   *  animated pair for the current pose (idle/done/failed/cancelled). */
  idle: Texture;
  typing: readonly [Texture, Texture];
  reading: readonly [Texture, Texture];
}

export interface OfficeTextures {
  /** Indexed by CharacterIndex (see roster.ts) — always CHARACTER_COUNT long. */
  characters: readonly CharacterTextureSet[];
  /** Indexed by wall bitmask (see wallAutoTile.ts), always 16 long. */
  wallByMask: readonly Texture[];
  floor: Texture;
  deskFront: Texture;
  pcOff: Texture;
  pcOn: readonly [Texture, Texture, Texture];
  bookshelf: Texture;
  whiteboard: Texture;
  coffee: Texture;
  clock: Texture;
  plant: Texture;
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
  const frame = (f: CharacterFrame) => sub(sheet, characterFrameRect(CharacterRow.DOWN, f));
  return {
    idle: frame(CharacterFrame.WALK_2),
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

    const wallSheet = nearest(loaded[WALL_URL]);
    const wallByMask: Texture[] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) wallByMask.push(sub(wallSheet, wallPieceRect(mask)));

    const pcOn = FURNITURE_URLS.pcFrontOn.map((url) => nearest(loaded[url])) as [Texture, Texture, Texture];

    const textures: OfficeTextures = {
      characters,
      wallByMask,
      floor: nearest(loaded[FLOOR_URL]),
      deskFront: nearest(loaded[FURNITURE_URLS.deskFront]),
      pcOff: nearest(loaded[FURNITURE_URLS.pcFrontOff]),
      pcOn,
      bookshelf: nearest(loaded[FURNITURE_URLS.bookshelf]),
      whiteboard: nearest(loaded[FURNITURE_URLS.whiteboard]),
      coffee: nearest(loaded[FURNITURE_URLS.coffee]),
      clock: nearest(loaded[FURNITURE_URLS.clock]),
      plant: nearest(loaded[FURNITURE_URLS.plant]),
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
