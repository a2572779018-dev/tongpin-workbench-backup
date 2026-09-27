import { Container, Sprite, TilingSprite, type Texture } from "pixi.js";
import { computeLayout, DECOR_LAYOUT, TILE, WALL_ROW_HEIGHT, WORLD_HEIGHT, WORLD_WIDTH } from "./seating";
import { getOfficeTextures } from "./spriteSheets";
import { wallMaskForRow } from "./wallAutoTile";

// The office's static backdrop, built from Pixel Agents' own furniture/floor/
// wall art (see THIRD_PARTY_NOTICES.md) instead of the office's previous
// procedurally-drawn Graphics backdrop. Every sprite here sits at native
// pixel size — 1 world unit = 1 texture pixel, per seating.ts — so the
// camera's single integer zoom (Camera.ts) is the only scaling ever applied,
// keeping every tile crisp.

/** Multiply-tint for the floor tile art, which Pixel Agents ships as plain
 *  grayscale so its own in-app editor can recolor it per project (see
 *  THIRD_PARTY_NOTICES.md). This scene has no color picker — just one fixed
 *  warm tone to match 同频's palette — so a cheap Sprite/TilingSprite `tint`
 *  stands in for porting that editor's full colorize step. Every other
 *  sprite here (wall, furniture, characters) already ships fully colored and
 *  is drawn untinted. */
const FLOOR_TINT = 0xe4c99a;

function placeSprite(container: Container, texture: Texture, x: number, y: number): Sprite {
  const sprite = new Sprite(texture);
  sprite.position.set(x, y);
  container.addChild(sprite);
  return sprite;
}

export function buildOfficeBackdrop(): Container {
  const textures = getOfficeTextures();
  const root = new Container();

  const floor = new TilingSprite({
    texture: textures.floor,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT - WALL_ROW_HEIGHT,
  });
  floor.position.set(0, WALL_ROW_HEIGHT);
  floor.tint = FLOOR_TINT;
  root.addChild(floor);

  // One row of auto-tiled wall pieces spanning the full width — see
  // wallAutoTile.ts for why this reduces to just an east/west neighbor check.
  const wallCols = WORLD_WIDTH / TILE;
  for (let col = 0; col < wallCols; col++) {
    placeSprite(root, textures.wallByMask[wallMaskForRow(col, wallCols)], col * TILE, 0);
  }

  placeSprite(root, textures.bookshelf, DECOR_LAYOUT.bookshelf.x, DECOR_LAYOUT.bookshelf.y);
  placeSprite(root, textures.whiteboard, DECOR_LAYOUT.whiteboard.x, DECOR_LAYOUT.whiteboard.y);
  placeSprite(root, textures.clock, DECOR_LAYOUT.clock.x, DECOR_LAYOUT.clock.y);
  placeSprite(root, textures.plant, DECOR_LAYOUT.plantLeft.x, DECOR_LAYOUT.plantLeft.y);
  placeSprite(root, textures.plant, DECOR_LAYOUT.plantRight.x, DECOR_LAYOUT.plantRight.y);

  // The coordinator's desk rect is fixed (computeLayout's head-desk position
  // never depends on the worker list — see seating.ts), so the coffee mug can
  // be anchored to it here without waiting for a real coordinator figure.
  const headDesk = computeLayout([]).coordinator;
  placeSprite(
    root,
    textures.coffee,
    headDesk.x + DECOR_LAYOUT.coffeeDeskInsetX,
    headDesk.y + DECOR_LAYOUT.coffeeDeskInsetY,
  );

  return root;
}
