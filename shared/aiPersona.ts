export type AiPersonaTone = "warm" | "professional" | "concise" | "creative";

/** `auto` follows application state; all other ids exactly match the exported FleurSays API. */
export const AI_PERSONA_EXPRESSIONS = [
  "auto", "none", "hmm", "question", "zzz", "aha", "smitten", "oh",
  "yes", "nope", "meh", "grr", "wow", "woozy",
] as const;
export type AiPersonaExpression = typeof AI_PERSONA_EXPRESSIONS[number];

export const AI_PERSONA_EXPRESSION_LABELS: Record<AiPersonaExpression, string> = {
  auto: "自动", none: "无表情符号", hmm: "思考", question: "疑问", zzz: "困倦",
  aha: "灵感", smitten: "喜欢", oh: "惊讶", yes: "赞同", nope: "摇头",
  meh: "平静", grr: "生气", wow: "赞叹", woozy: "晕乎乎",
};

export function isAiPersonaExpression(value: unknown): value is AiPersonaExpression {
  return typeof value === "string" && (AI_PERSONA_EXPRESSIONS as readonly string[]).includes(value);
}

/** Explicitly confirmed member preferences, never automatically extracted private chat facts. */
export interface AiPersonaProfile {
  /** This member's chosen name for the assistant, not the member's account name. Empty means 同频AI. */
  name: string;
  tone: AiPersonaTone;
  customStyle: string;
  preferences: string;
  onboardingComplete: boolean;
  /** Visual preference only. Missing on older clients/records; never included in model instructions. */
  expression?: AiPersonaExpression;
}

export interface AiPersonaSnapshot {
  revision: number;
  profile: AiPersonaProfile;
}

export type AiPersonaSaveRequest =
  | { expectedRevision: number; profile: AiPersonaProfile; reset?: false }
  | { expectedRevision: number; reset: true };

export const AI_PERSONA_LIMITS = {
  nameCharacters: 40,
  customStyleCharacters: 2000,
  preferencesCharacters: 4000,
  requestBytes: 32 * 1024,
} as const;

export function defaultAiPersonaProfile(): AiPersonaProfile {
  return { name: "", tone: "warm", customStyle: "", preferences: "", onboardingComplete: false, expression: "auto" };
}
