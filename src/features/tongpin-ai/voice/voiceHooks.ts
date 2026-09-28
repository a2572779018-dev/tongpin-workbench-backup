import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { EMPTY_AI_VOICE_MEMBER_SETTINGS, type AiVoiceMemberSettings } from "../../../../shared/aiVoice";
import { useAuth } from "../../../auth/AuthContext";
import { ApiRequestError } from "../../../lib/api";
import { joinTranscript } from "./recorderState";
import { speechPlayer, type SpeechStatus } from "./speechPlayer";
import { isVoiceCaptureActive } from "./useVoiceRecorder";
import {
  ensureVoiceSettings, invalidateVoiceSettings, subscribeVoiceSettings, synthesizeSpeech, voiceSettingsSnapshot, type VoiceApi,
} from "./voiceApi";
import {
  DEFAULT_VOICE_PREFERENCES, effectiveVoicePreferences, normalizeVoicePreferences, readVoicePreferences,
  speechChoice, subscribeVoicePreferences, type VoicePreferences,
} from "./voicePreferences";

/** The workspace can render without an AuthProvider (static rendering in
 * tests); voice then stays hidden instead of throwing. */
export function useOptionalAuth(): ReturnType<typeof useAuth> | null {
  try { return useAuth(); } catch { return null; }
}

const DEFAULT_PREFERENCES_SNAPSHOT = JSON.stringify(DEFAULT_VOICE_PREFERENCES);

export function useVoicePreferences(accountId: string | undefined): VoicePreferences {
  const snapshot = useSyncExternalStore(
    subscribeVoicePreferences,
    () => JSON.stringify(readVoicePreferences(accountId)),
    () => DEFAULT_PREFERENCES_SNAPSHOT,
  );
  return useMemo(() => normalizeVoicePreferences(JSON.parse(snapshot)), [snapshot]);
}

export function useVoiceSettings(api: VoiceApi | undefined, accountId: string | undefined): AiVoiceMemberSettings {
  const settings = useSyncExternalStore(subscribeVoiceSettings, () => voiceSettingsSnapshot(accountId), () => EMPTY_AI_VOICE_MEMBER_SETTINGS);
  useEffect(() => {
    if (api && accountId) void ensureVoiceSettings(api, accountId);
  }, [api, accountId]);
  return settings;
}

const noSubscription = () => () => undefined;

export function useSpeechSupported(): boolean {
  return useSyncExternalStore(noSubscription, () => typeof window !== "undefined" && ("speechSynthesis" in window || typeof Audio !== "undefined"), () => false);
}

export function useSpeechPlayback(key: string): { status: SpeechStatus; error: string } {
  const snapshot = useSyncExternalStore(speechPlayer.subscribe, () => speechPlayer.snapshot(key), () => "idle\u0000");
  const [status, error] = snapshot.split("\u0000");
  return { status: status as SpeechStatus, error: error ?? "" };
}

function shouldFallBackToLocalSpeech(error: unknown): boolean {
  return error instanceof ApiRequestError && ["AI_VOICE_SPEECH_LOCAL", "AI_VOICE_NOT_CONFIGURED"].includes(error.code);
}

/** Reads one reply with the member's rate and voice, on the engine the administrator allows. */
export async function startReading({ key, content, api, accountId }: { key: string; content: string; api?: VoiceApi; accountId?: string }): Promise<void> {
  const ticket = speechPlayer.prepare(key);
  const preferences = readVoicePreferences(accountId);
  let settings = voiceSettingsSnapshot(accountId);
  if (api && accountId) settings = await ensureVoiceSettings(api, accountId).catch(() => settings);
  const choice = speechChoice(settings.speech, preferences);
  const external = choice.engine === "external" && Boolean(api && accountId);
  const result = await speechPlayer.play(key, content, {
    engine: external ? "external" : "browser",
    rate: preferences.rate,
    ...(external ? { synthesize: (text: string, signal: AbortSignal) => synthesizeSpeech(api!, accountId!, text, signal, choice.voice) } : {}),
  }, ticket);
  // The administrator switched back to system voices after this view loaded.
  if (result.outcome === "failed" && external && shouldFallBackToLocalSpeech(result.error)) {
    invalidateVoiceSettings();
    await speechPlayer.play(key, content, { engine: "browser", rate: preferences.rate });
  }
}

interface ReplySnapshot { conversationId?: string; id?: string; role?: string; status?: string }

/** A reply that finishes streaming while visible is read aloud when the member
 * turned on auto-read or voice conversation mode. History never auto-plays. */
export function useVoiceAutoRead(conversationId: string | undefined, message: { id: string; role: string; status?: string; content: string } | undefined): void {
  const auth = useOptionalAuth();
  const accountId = auth?.session?.user.id;
  const api = auth?.api;
  const previous = useRef<ReplySnapshot>({});
  const id = message?.id, role = message?.role, status = message?.status, content = message?.content ?? "";
  useEffect(() => {
    const before = previous.current;
    previous.current = { conversationId, id, role, status };
    const completed = Boolean(id && role === "assistant" && before.conversationId === conversationId && before.id === id
      && (before.status === "thinking" || before.status === "typing") && (status === "ready" || status === undefined));
    if (!completed || !content.trim() || isVoiceCaptureActive() || !effectiveVoicePreferences(readVoicePreferences(accountId)).autoRead) return;
    void startReading({ key: id!, content, api, accountId });
  }, [accountId, api, content, conversationId, id, role, status]);
  // Leaving the conversation (or the workspace) always silences it.
  useEffect(() => () => speechPlayer.stop(), [conversationId]);
}

/** Inserts a transcript into the composer draft; with auto-send it submits
 * once the parent has rendered that exact draft (props are never stale). */
export function useVoiceTranscriptInsert(draft: string, onDraftChange: (value: string) => void, submit: () => void, focus?: () => void): (text: string, autoSend: boolean) => void {
  const pending = useRef<{ text: string; expires: number } | null>(null);
  const latest = useRef({ draft, onDraftChange, submit, focus });
  latest.current = { draft, onDraftChange, submit, focus };
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    if (Date.now() > target.expires) { pending.current = null; return; }
    if (draft !== target.text) return;
    pending.current = null;
    latest.current.submit();
  }, [draft]);
  return useCallback((text: string, autoSend: boolean) => {
    const next = joinTranscript(latest.current.draft, text);
    if (next === latest.current.draft) return;
    pending.current = autoSend ? { text: next, expires: Date.now() + 3000 } : null;
    latest.current.onDraftChange(next);
    if (!autoSend) latest.current.focus?.();
  }, []);
}
