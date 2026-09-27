import { Container, Sprite, TilingSprite, type Texture } from "pixi.js";
import { buildDecorLayout, UI_SCALE, WALL_ROW_HEIGHT, WORLD_HEIGHT, WORLD_WIDTH } from "./seating";
import { getOfficeTextures } from "./spriteSheets";

// The office's static backdrop, built from LimeZu's own floor/wall/furniture
// art (see THIRD_PARTY_NOTICES.md) instead of the office's previous
// procedurally-drawn Graphics backdrop. Every decor sprite here is drawn at
// UI_SCALE (see seating.ts) so it matches the desks/characters it sits next
// to; the camera's own scale (Camera.ts) is the only further scaling ever
// applied on top, keeping every tile crisp. Backdrop decor is intentionally
// static (no per-frame animation) — the same convention this scene's desks/
// characters aside, this office has always used: only a worker's own desk
// monitor and character pose animate (see Desk.ts / CharacterSprite.ts),
// driven by OfficeSceneController's tick.
//
// `worldWidth` is a parameter (not read from the seating.ts constant
// directly) because the world's own width now varies with the host panel's
// measured size — see seating.ts's computeWorldWidth() and
// OfficeSceneController's rebuild-on-resize handling.

function placeSprite(container: Container, texture: Texture, x: number, y: number, scale = UI_SCALE): Sprite {
  const sprite = new Sprite(texture);
  sprite.scale.set(scale);
  sprite.position.set(x, y);
  container.addChild(sprite);
  return sprite;
}

export function buildOfficeBackdrop(worldWidth: number = WORLD_WIDTH): Container {
  const textures = getOfficeTextures();
  const decor = buildDecorLayout(worldWidth);
  const root = new Container();

  const floor = new TilingSprite({
    texture: textures.floor,
    width: worldWidth,
    height: WORLD_HEIGHT - WALL_ROW_HEIGHT,
  });
  floor.tileScale.set(UI_SCALE);
  floor.position.set(0, WALL_ROW_HEIGHT);
  root.addChild(floor);

  const wall = new TilingSprite({ texture: textures.wall, width: worldWidth, height: WALL_ROW_HEIGHT });
  wall.tileScale.set(UI_SCALE);
  root.addChild(wall);

  const baseboardH = textures.baseboard.height * UI_SCALE;
  const baseboard = new TilingSprite({ texture: textures.baseboard, width: worldWidth, height: baseboardH });
  baseboard.tileScale.set(UI_SCALE);
  baseboard.position.set(0, WALL_ROW_HEIGHT - baseboardH / 2);
  root.addChild(baseboard);

  placeSprite(root, textures.window, decor.window.x, decor.window.y);
  placeSprite(root, textures.door, decor.door.x, decor.door.y);
  placeSprite(root, textures.clock, decor.clock.x, decor.clock.y);
  placeSprite(root, textures.signboard, decor.signboard.x, decor.signboard.y);
  placeSprite(root, textures.whiteboard, decor.whiteboard.x, decor.whiteboard.y);
  placeSprite(root, textures.bookshelfA, decor.bookshelf.x, decor.bookshelf.y);
  placeSprite(root, textures.bookshelfB, decor.bookshelf2.x, decor.bookshelf2.y);
  placeSprite(root, textures.plantBig, decor.plantLeft.x, decor.plantLeft.y);
  placeSprite(root, textures.plantSmall, decor.plantRight.x, decor.plantRight.y);
  placeSprite(root, textures.waterCooler, decor.waterCooler.x, decor.waterCooler.y);
  placeSprite(root, textures.coffee, decor.coffee.x, decor.coffee.y);

  return root;
}
