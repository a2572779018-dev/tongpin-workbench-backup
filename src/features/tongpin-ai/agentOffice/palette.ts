// Numeric-hex palette for the Pixi-drawn office scene, matching 同频's warm
// light theme (see ai-metal-theme.css / reply-process.css / tongpin-ai.css).
// Pixi fills want 0xRRGGBB numbers, so this module is the single place that
// mirrors those CSS custom properties into numbers; the DOM fallback/card
// reuse the string forms so both surfaces read as one system.

export const paletteHex = {
  ink: "#292a25",
  inkFaint: "#77796f",
  muted: "#8a8c83",
  paper: "#f4efe4",
  cream: "#fbf9f2",
  white: "#fffaf0",
  border: "#d3cbb9",
  borderSoft: "#ded9ca",
  yellow: "#eed887",
  yellowStrong: "#ffd84d",
  green: "#a9e76c",
  blue: "#8cbcff",
  red: "#954c3d",
  redSoft: "#fbeee9",
  floor: "#f1ead4",
  wall: "#f5efe4",
  desk: "#d7cdb7",
  deskShade: "#c3b795",
  plant: "#7fa864",
  plantPot: "#c17a4f",
} as const;

function toNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

export const palette = Object.fromEntries(
  Object.entries(paletteHex).map(([key, value]) => [key, toNumber(value)]),
) as Record<keyof typeof paletteHex, number>;
