// Tiny per-character portrait images for the DOM/no-WebGL fallback
// (AgentOfficeFallback.tsx) — see THIRD_PARTY_NOTICES.md for provenance
// (cropped from the same LimeZu premade-character sheets as the canvas
// scene's char_N.png strips, just the idle frame alone).
//
// Unlike every other sprite this feature owns (spriteAssets.ts, always
// `?url&no-inline` so it's fetched only from the lazy office/Pixi chunk),
// these plain imports are deliberately EAGER, in the *main* bundle: the DOM
// fallback is itself an eager component (see AgentOfficeView.tsx's own doc
// comment on the eager/lazy boundary) that must render without ever loading
// Pixi, so the portraits it shows can't live behind that same dynamic
// import(). Each file is a single 16×16 frame — small enough that Vite
// inlines it as a data URI well under the default 4KB threshold, so this adds
// a few small base64 strings to the main bundle rather than extra requests;
// see the feature's report for the exact byte cost.

import portrait1 from "./assets/portraits/portrait_1.png";
import portrait2 from "./assets/portraits/portrait_2.png";
import portrait3 from "./assets/portraits/portrait_3.png";
import portrait4 from "./assets/portraits/portrait_4.png";
import portrait5 from "./assets/portraits/portrait_5.png";
import portrait6 from "./assets/portraits/portrait_6.png";
import portrait7 from "./assets/portraits/portrait_7.png";
import { characterIndexForRecipe, type RecipeKey } from "./roster";

/** Indexed by CharacterIndex (see roster.ts) — index 6 is the coordinator's
 *  exclusive portrait. */
const PORTRAIT_URLS: readonly string[] = [
  portrait1,
  portrait2,
  portrait3,
  portrait4,
  portrait5,
  portrait6,
  portrait7,
];

export function portraitForRecipe(recipe: RecipeKey): string {
  return PORTRAIT_URLS[characterIndexForRecipe(recipe)];
}
