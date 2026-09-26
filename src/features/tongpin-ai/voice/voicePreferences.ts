/**
 * Per-member voice preferences, kept only in this device's localStorage.
 * Every storage access is wrapped: a private window, disabled storage or a
 * full quota silently falls back to the defaults.
 */
export interface VoicePreferences {
  /** LibreChat's "conversation mode": auto-send, auto-read and stop on silence. */
  conversationMode: boolean;
  autoSend: boolean;
  autoRead: boolean;
  /** Speaking rate for read-aloud (1 = normal). */
  rate: number;
}

export const SPEECH_RATES = [0.8, 1, 1.25, 1.5] as const;
export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = Object.freeze({ conversationMode: false, autoSend: false, autoRead: false, rate: 1 });

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PreferenceStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function voicePreferencesKey(accountId: string | undefined): string {
  return `tongpin.ai.voice.v1:${accountId || "guest"}`;
}

export function normalizeVoicePreferences(value: unknown): VoicePreferences {
  const input = value && typeof value === "object" ? value as Partial<Record<keyof VoicePreferences, unknown>> : {};
  const rate = typeof input.rate === "number" && (SPEECH_RATES as readonly number[]).includes(input.rate) ? input.rate : DEFAULT_VOICE_PREFERENCES.rate;
  return {
    conversationMode: input.conversationMode === true,
    autoSend: input.autoSend === true,
    autoRead: input.autoRead === true,
    rate,
  };
}

export function readVoicePreferences(accountId: string | undefined, storage: PreferenceStorage | null = defaultStorage()): VoicePreferences {
  try {
    const raw = storage?.getItem(voicePreferencesKey(accountId));
    return raw ? normalizeVoicePreferences(JSON.parse(raw)) : { ...DEFAULT_VOICE_PREFERENCES };
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
}

const listeners = new Set<() => void>();

export function writeVoicePreferences(accountId: string | undefined, preferences: VoicePreferences, storage: PreferenceStorage | null = defaultStorage()): void {
  try { storage?.setItem(voicePreferencesKey(accountId), JSON.stringify(normalizeVoicePreferences(preferences))); } catch { /* Preferences are a convenience. */ }
  for (const listener of listeners) listener();
}

export function subscribeVoicePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What the member's switches mean right now. */
export function effectiveVoicePreferences(preferences: VoicePreferences): { autoSend: boolean; autoRead: boolean; stopOnSilence: boolean } {
  return {
    autoSend: preferences.conversationMode || preferences.autoSend,
    autoRead: preferences.conversationMode || preferences.autoRead,
    stopOnSilence: preferences.conversationMode,
  };
}
