import { Graphics } from "pixi.js";
import { palette } from "./palette";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./seating";

// Procedural office backdrop — floor, wall band, a couple of plants — drawn
// entirely with Pixi Graphics in 同频's warm palette. No tileset/map asset is
// involved (see THIRD_PARTY_NOTICES.md: the LimeZu tilesets in the reference
// project are not reused; this is original art).

const WALL_H = 34;

function drawPlant(g: Graphics, x: number, y: number): void {
  g.roundRect(x - 7, y - 10, 14, 10, 2).fill(palette.plantPot);
  g.rect(x - 7, y - 2, 14, 2).fill(palette.deskShade);
  const leaf = (dx: number, dy: number, r: number) => {
    g.circle(x + dx, y - 10 + dy, r).fill(palette.plant);
  };
  leaf(0, -10, 7);
  leaf(-6, -4, 5);
  leaf(6, -4, 5);
}

export function drawOfficeBackdrop(g: Graphics): void {
  g.clear();
  g.rect(0, 0, WORLD_WIDTH, WALL_H).fill(palette.wall);
  g.rect(0, WALL_H, WORLD_WIDTH, WORLD_HEIGHT - WALL_H).fill(palette.floor);
  g.rect(0, WALL_H - 2, WORLD_WIDTH, 2).fill(palette.border);
  // A few faint floor plank lines for texture, nothing that reads as a grid.
  for (let x = 40; x < WORLD_WIDTH; x += 80) {
    g.rect(x, WALL_H, 1, WORLD_HEIGHT - WALL_H).fill({ color: palette.border, alpha: 0.35 });
  }
  drawPlant(g, 26, WORLD_HEIGHT - 14);
  drawPlant(g, WORLD_WIDTH - 26, WORLD_HEIGHT - 14);
}
