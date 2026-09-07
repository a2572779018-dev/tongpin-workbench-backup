/** Typed boundary for the user's purchased Fleur export; not an open-source license. */
export type FleurMood = "idle" | "listening" | "thinking" | "excited" | "happy" | "sad" | "angry" | "surprised" | "confused" | "curious" | "shy" | "wink" | "squint" | "sideEye" | "alert" | "scan" | "lookAround" | "peek" | "nod" | "shakeNo" | "bored" | "sleepy" | "yawn" | "sleep" | "meditate" | "bounce" | "dance" | "spin" | "tumble" | "dizzy";
export type Point = readonly [number, number];
export interface CharacterSpec { id: string; name: string; shape: string; body: string; eye: string; er: number | { x: number; y: number; z: number }; eyes: { w: number; h: number; sp: number; py: number; aL: number; aR: number }; }
export interface CharacterConfig {
  characterId: string; eyeStyleId: string; motionId: FleurMood; topperId: string;
  size: number; stretchX: number; stretchY: number; depth: number; perspective: number; turn: number; tilt: number; lean: number;
  bodyColor: string; surfaceId: string; lightColor: string; shadowColor: string; shine: number; shadow: number; lightX: number; lightY: number; lightSpread: number; gloss: number; rim: number; rimColor: string;
  eyeColor: string; irisColor: string; pupilColor: string; glintColor: string; eyeWidth: number; eyeHeight: number; eyeSpacing: number; eyeRaise: number; eyeAngle: number; irisSize: number; pupilSize: number; glintSize: number; eyeMorph: boolean;
  speed: number; motionAmount: number; blink: boolean; blinkRate: number; flush: boolean; glide: boolean; flushColors: Record<string, string>; motionParams: Record<string, Record<string, number>>;
  textureId: string; textureColors: Record<string, string>; textureWidth: number; textureOpacity: number; textureDensity: number;
  topperSize: number; topperSpread: number; topperHeight: number; topperAcross: number; topperLift: number; topperTilt: number; topperDepth: number; topperColor: string;
  impressionId: string; impressionGlyph: string; impressionText: string; impressionColor: string; impressionSize: number; impressionHeight: number; impressionDrops: number; impressionSpeed: number;
}
export interface Motion { id: FleurMood; label: string; steps: readonly { expressionId: string; transitionMs: number; holdMs: number; transition: string; eyeShape?: string }[]; blink: { enabled: boolean; initialDelayMs: number }; hop?: boolean; }
export interface EyeStyle { id: string; label: string; }
export interface Topper { loops: readonly { pts: readonly (readonly [number, number, number])[] }[]; thickness?: number; }
export interface Avatar { motion: Motion; clock: number; lastNow: number; }
export interface Drag { x: number; y: number; active: boolean; vx: number; vy: number; }
export interface FrameInput { config: CharacterConfig; style: EyeStyle; topper: Topper | null; drag?: Drag; headTracking?: { yaw: number; pitch: number; weight: number }; }
export interface Outline { pts: readonly number[]; ends: readonly number[]; }
export interface Transform { tx: number; ty: number; rot: number; sx: number; sy: number; }
export interface ColorRamp { light: string; mid: string; dark: string; }
export interface EyeGeometry { sclera: Outline; iris: Outline; pupil: Outline; glint: Outline; op: number; pop: number; }
export interface Frame {
  body: Outline; transform: Transform; eyeL: EyeGeometry | null; eyeR: EyeGeometry | null; eyeC: EyeGeometry | null;
  overlays: { id: string; o: Outline; color: string; opacity: number; blur: number }[];
  ramp: ColorRamp | null; texture?: { o: Outline; closed: boolean; fill?: string; stroke?: string; width: number; opacity: number }[];
}
export interface SvgEye { d: string; op: string; id: string; pd: string; gd: string; pop: string; }
export interface SvgFrame {
  bodyD: string; groupTransform: string; eyeL: SvgEye | null; eyeR: SvgEye | null; eyeC: SvgEye | null;
  overlays: { id: string; d: string; fill: string; op: string; blur: number }[]; ramp: ColorRamp | null;
  texture: { d: string; fill: string; stroke: string; width: string; op: string }[];
}
export interface BodyPaint extends ColorRamp {
  cx: number; cy: number; r: number; scaleX: number; scaleY: number;
  stops?: { offset: number | string; color: string; opacity: number }[]; seam?: boolean;
  gloss: { cx: number; cy: number; r: number; color: string; opacity: number } | null;
  rim: { r: number; inner: number; color: string; opacity: number } | null;
}
export interface ImpressionPlan {
  kind: "text" | "icon"; pts: readonly Point[];
  letters: readonly { ch: string; x: number; first: number; last: number; setT: number; loops: readonly (readonly Point[])[] }[];
  stag: number; dotR: number; setT: number; polys: readonly { pts: readonly Point[]; closed: boolean }[] | null;
  sw: number; dot: Point | null; filled: boolean; word: string; fontSize: number;
}
export interface ImpressionInput { rim: number; size: number; height: number; drops: number; t: number; }
export interface ImpressionFrame { drops: { x: number; y: number; r: number }[]; glyph: Outline | null; glyphOpacity: number; }
export interface SvgImpression { drops: { cx: string; cy: string; r: string }[]; glyphD: string; glyphOpacity: string; }
export declare function computeFrame(avatar: Avatar, now: number, input: FrameInput): Frame;
export declare function computeStaticFrame(spec: CharacterSpec, motion: Motion, input: FrameInput, dense?: boolean, seedOff?: number, detail?: number): Frame;
export declare function createAvatar(spec: CharacterSpec, motion: Motion, dense: boolean, seedOff?: number, detail?: number): Avatar;
export declare function play(avatar: Avatar, motion: Motion): void;
export declare function bodyPaint(config: CharacterConfig, spec: CharacterSpec): BodyPaint;
export declare function topperById(id: string, detail?: number): Topper | null;
export declare function contentExtent(spec: CharacterSpec, config: CharacterConfig, topper: Topper | null, motion?: Motion): number;
export declare function svgFrame(frame: Frame): SvgFrame;
export declare function pathD(outline: Outline | null, closed?: boolean): string;
export declare function transformAttr(transform: Transform): string;
export declare function opacityAttr(value: number): string;
export declare function moveDrag(drag: Drag, dx: number, dy: number, dtMs: number): void;
export declare function stepDrag(drag: Drag, dtMs: number): void;
export declare function impressionFrame(plan: ImpressionPlan, input: ImpressionInput): ImpressionFrame;
export declare function impressionReach(input: Pick<ImpressionInput, "rim" | "size" | "height">): number;
export declare function svgImpression(frame: ImpressionFrame): SvgImpression;
export declare const EYE_STYLE_BY_ID: Record<string, EyeStyle>;
export declare const EYE_STYLES: EyeStyle[];
export declare const MOTION_BY_ID: Record<FleurMood, Motion>;
export declare const MOTIONS: Motion[];
export declare const TOPPERS: { id: string; label: string }[];
export declare const DRAG_GAIN: number;
// Unused native-renderer exports remain typed rather than silently missing.
export interface PathLike { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; close(): void; }
export interface SkiaFactory<P extends PathLike> { Path: { Make(): P }; }
export declare function fillOutline<P extends PathLike>(path: P, outline: Outline | null): P;
export declare function outlineToPath<P extends PathLike>(skia: SkiaFactory<P>, outline: Outline | null, closed?: boolean): P | null;
export declare function skiaFrame<P extends PathLike>(skia: SkiaFactory<P>, frame: Frame): { body: P | null; transform: Transform; eyeL: unknown; eyeR: unknown; eyeC: unknown; overlays: unknown[]; ramp: ColorRamp | null; texture: unknown[] };
export declare function skiaImpression<P extends PathLike>(skia: SkiaFactory<P>, frame: ImpressionFrame): { drops: ImpressionFrame["drops"]; glyph: P | null; glyphOpacity: number };
