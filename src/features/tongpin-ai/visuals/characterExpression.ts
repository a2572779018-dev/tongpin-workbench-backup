import type { AiPersonaExpression } from "../../../../shared/aiPersona";
import type { FleurMood, FleurSays } from "./fleur/FleurCharacter";

export const CHARACTER_EXPRESSIONS = [
  { id: "auto", label: "自动", glyph: "✦", mood: "idle" },
  { id: "none", label: "平静", glyph: "—", mood: "idle" },
  { id: "hmm", label: "思考", glyph: "hmm…", mood: "thinking" },
  { id: "question", label: "好奇", glyph: "?", mood: "curious" },
  { id: "zzz", label: "困困", glyph: "zzz", mood: "sleepy" },
  { id: "aha", label: "灵感", glyph: "!", mood: "alert" },
  { id: "smitten", label: "喜欢", glyph: "♥", mood: "happy" },
  { id: "oh", label: "惊喜", glyph: "oh!", mood: "surprised" },
  { id: "yes", label: "完成", glyph: "✓", mood: "happy" },
  { id: "nope", label: "摇头", glyph: "×", mood: "shakeNo" },
  { id: "meh", label: "放空", glyph: "meh", mood: "bored" },
  { id: "grr", label: "气鼓鼓", glyph: "grr", mood: "angry" },
  { id: "wow", label: "赞叹", glyph: "wow", mood: "excited" },
  { id: "woozy", label: "晕乎乎", glyph: "∿", mood: "dizzy" },
] as const satisfies ReadonlyArray<{ id: AiPersonaExpression; label: string; glyph: string; mood: FleurMood }>;

export type CharacterActivity = "idle" | "waiting" | "typing" | "completed" | "error";

export interface CharacterReplySnapshot {
  conversationId?: string;
  messageId?: string;
  role?: "user" | "assistant";
  status?: "thinking" | "typing" | "ready" | "error" | "stopped";
}

export function didCharacterReplyComplete(previous: CharacterReplySnapshot, current: CharacterReplySnapshot): boolean {
  return Boolean(current.messageId && previous.conversationId === current.conversationId
    && previous.messageId === current.messageId && previous.role === "assistant" && current.role === "assistant"
    && (previous.status === "thinking" || previous.status === "typing") && current.status === "ready");
}

/** Task states take priority so a saved happy expression never signifies success on a failed request. */
export function resolveCharacterExpression(expression: AiPersonaExpression = "auto", activity: CharacterActivity = "idle"): { mood: FleurMood; says: FleurSays } {
  if (activity === "waiting") return { mood: "thinking", says: "hmm" };
  if (activity === "typing") return { mood: "listening", says: "none" };
  if (activity === "completed") return { mood: "happy", says: "yes" };
  if (activity === "error") return { mood: "confused", says: "question" };
  const option = CHARACTER_EXPRESSIONS.find(item => item.id === expression) ?? CHARACTER_EXPRESSIONS[0];
  return { mood: option.mood, says: option.id === "auto" ? "none" : option.id };
}
