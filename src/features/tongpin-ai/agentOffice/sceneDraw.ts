import { Container, Sprite, TilingSprite, type Texture } from "pixi.js";
import { DECOR_LAYOUT, UI_SCALE, WALL_ROW_HEIGHT, WORLD_HEIGHT, WORLD_WIDTH } from "./seating";
import { getOfficeTextures } from "./spriteSheets";

// The office's static backdrop, built from LimeZu's own floor/wall/furniture
// art (see THIRD_PARTY_NOTICES.md) instead of the office's previous
// procedurally-drawn Graphics backdrop. Every decor sprite here is drawn at
// UI_SCALE (see seating.ts) so it matches the desks/characters it sits next
// to; the camera's own single integer zoom (Camera.ts) is the only further
// scaling ever applied on top, keeping every tile crisp. Backdrop decor is
// intentionally static (no per-frame animation) — the same convention this
// scene's desks/characters aside, this office has always used: only a
// worker's own desk monitor and character pose animate (see Desk.ts /
// CharacterSprite.ts), driven by OfficeSceneController's tick.

function placeSprite(container: Container, texture: Texture, x: number, y: number, scale = UI_SCALE): Sprite {
  const sprite = new Sprite(texture);
  sprite.scale.set(scale);
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
  floor.tileScale.set(UI_SCALE);
  floor.position.set(0, WALL_ROW_HEIGHT);
  root.addChild(floor);

  const wall = new TilingSprite({ texture: textures.wall, width: WORLD_WIDTH, height: WALL_ROW_HEIGHT });
  wall.tileScale.set(UI_SCALE);
  root.addChild(wall);

  const baseboardH = textures.baseboard.height * UI_SCALE;
  const baseboard = new TilingSprite({ texture: textures.baseboard, width: WORLD_WIDTH, height: baseboardH });
  baseboard.tileScale.set(UI_SCALE);
  baseboard.position.set(0, WALL_ROW_HEIGHT - baseboardH / 2);
  root.addChild(baseboard);

  placeSprite(root, textures.door, DECOR_LAYOUT.door.x, DECOR_LAYOUT.door.y);
  placeSprite(root, textures.clock[0], DECOR_LAYOUT.clock.x, DECOR_LAYOUT.clock.y);
  placeSprite(root, textures.signboard, DECOR_LAYOUT.signboard.x, DECOR_LAYOUT.signboard.y);
  placeSprite(root, textures.whiteboard, DECOR_LAYOUT.whiteboard.x, DECOR_LAYOUT.whiteboard.y);
  placeSprite(root, textures.bookshelfA, DECOR_LAYOUT.bookshelf.x, DECOR_LAYOUT.bookshelf.y);
  placeSprite(root, textures.bookshelfB, DECOR_LAYOUT.bookshelf2.x, DECOR_LAYOUT.bookshelf2.y);
  placeSprite(root, textures.plantBig, DECOR_LAYOUT.plantLeft.x, DECOR_LAYOUT.plantLeft.y);
  placeSprite(root, textures.plantSmall, DECOR_LAYOUT.plantRight.x, DECOR_LAYOUT.plantRight.y);
  placeSprite(root, textures.waterCooler, DECOR_LAYOUT.waterCooler.x, DECOR_LAYOUT.waterCooler.y);
  placeSprite(root, textures.coffee[0], DECOR_LAYOUT.coffee.x, DECOR_LAYOUT.coffee.y);

  return root;
}
