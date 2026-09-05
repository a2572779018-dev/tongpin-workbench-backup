export type AiPersonaTone = "warm" | "professional" | "concise" | "creative";

/** Explicitly confirmed member preferences, never automatically extracted private chat facts. */
export interface AiPersonaProfile {
  /** This member's chosen name for the assistant, not the member's account name. Empty means 同频AI. */
  name: string;
  tone: AiPersonaTone;
  customStyle: string;
  preferences: string;
  onboardingComplete: boolean;
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
  return { name: "", tone: "warm", customStyle: "", preferences: "", onboardingComplete: false };
}
