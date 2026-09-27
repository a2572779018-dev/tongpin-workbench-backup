import { Container, Graphics, Sprite, TilingSprite, type Texture } from "pixi.js";
import { palette } from "./palette";
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

/** Warm cross-mullioned window, painted rather than cropped from a LimeZu
 *  sheet — see seating.ts's DecorLayout.window doc comment for why (no window
 *  art in the owner's purchased theme categories). Kept to the scene's own
 *  palette so it reads as part of the same room instead of a mismatched
 *  add-on. */
function drawWindow(container: Container, x: number, y: number, w: number, h: number): void {
  const g = new Graphics();
  g.roundRect(0, 0, w, h, 3).fill({ color: palette.blue, alpha: 0.55 }).stroke({ color: palette.ink, width: 2 });
  g.rect(w / 2 - 1, 2, 2, h - 4).fill({ color: palette.ink, alpha: 0.7 });
  g.rect(2, h / 2 - 1, w - 4, 2).fill({ color: palette.ink, alpha: 0.7 });
  g.position.set(x, y);
  g.scale.set(UI_SCALE);
  container.addChild(g);
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

  if (decor.rug.w > 0 && decor.rug.h > 0) {
    const rug = new TilingSprite({ texture: textures.rug, width: decor.rug.w, height: decor.rug.h });
    rug.tileScale.set(UI_SCALE);
    rug.position.set(decor.rug.x, decor.rug.y);
    rug.alpha = 0.9;
    root.addChild(rug);
  }

  const wall = new TilingSprite({ texture: textures.wall, width: worldWidth, height: WALL_ROW_HEIGHT });
  wall.tileScale.set(UI_SCALE);
  root.addChild(wall);

  const baseboardH = textures.baseboard.height * UI_SCALE;
  const baseboard = new TilingSprite({ texture: textures.baseboard, width: worldWidth, height: baseboardH });
  baseboard.tileScale.set(UI_SCALE);
  baseboard.position.set(0, WALL_ROW_HEIGHT - baseboardH / 2);
  root.addChild(baseboard);

  drawWindow(root, decor.window.x, decor.window.y, decor.window.w, decor.window.h);
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
