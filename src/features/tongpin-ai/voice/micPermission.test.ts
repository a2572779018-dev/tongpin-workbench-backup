import { describe, expect, it, vi } from "vitest";
import type { MicrophoneAccessStatus, MicrophoneBridge } from "../../../../shared/aiVoice";
import { classifyMicrophoneError, ensureMicrophoneAccess, microphoneGuidance, microphoneIssue } from "./micPermission";
import {
  DEFAULT_VOICE_PREFERENCES, effectiveVoicePreferences, normalizeVoicePreferences, readVoicePreferences, subscribeVoicePreferences,
  voicePreferencesKey, writeVoicePreferences,
} from "./voicePreferences";

function bridge(status: MicrophoneAccessStatus, after: MicrophoneAccessStatus = status): MicrophoneBridge & { request: ReturnType<typeof vi.fn> } {
  return { status: vi.fn(async () => status), request: vi.fn(async () => after), openSettings: vi.fn(async () => true) };
}

describe("microphone permission helper", () => {
  it("asks the desktop bridge first and prompts only while undecided", async () => {
    const undecided = bridge("not-determined", "granted");
    expect(await ensureMicrophoneAccess(undecided)).toEqual({ ok: true });
    expect(undecided.request).toHaveBeenCalledTimes(1);
    const granted = bridge("granted");
    expect(await ensureMicrophoneAccess(granted)).toEqual({ ok: true });
    expect(granted.request).not.toHaveBeenCalled();
    expect(await ensureMicrophoneAccess(bridge("not-determined", "denied"))).toEqual({ ok: false, reason: "denied" });
    expect(await ensureMicrophoneAccess(bridge("denied"))).toEqual({ ok: false, reason: "denied" });
    expect(await ensureMicrophoneAccess(bridge("restricted"))).toEqual({ ok: false, reason: "restricted" });
    // Linux / unknown: getUserMedia and the session handler decide.
    expect(await ensureMicrophoneAccess(bridge("unknown"))).toEqual({ ok: true });
    expect(await ensureMicrophoneAccess(undefined)).toEqual({ ok: true });
    const broken = { status: vi.fn(async () => { throw new Error("ipc"); }), request: vi.fn(), openSettings: vi.fn() } as unknown as MicrophoneBridge;
    expect(await ensureMicrophoneAccess(broken)).toEqual({ ok: true });
  });

  it("maps getUserMedia failures to reasons", () => {
    const error = (name: string) => Object.assign(new Error(name), { name });
    expect(classifyMicrophoneError(error("NotAllowedError"))).toBe("denied");
    expect(classifyMicrophoneError(error("SecurityError"))).toBe("denied");
    expect(classifyMicrophoneError(error("NotFoundError"))).toBe("no-device");
    expect(classifyMicrophoneError(error("NotReadableError"))).toBe("busy");
    expect(classifyMicrophoneError(error("NotSupportedError"))).toBe("unsupported");
    expect(classifyMicrophoneError("weird")).toBe("unknown");
  });

  it("gives platform-specific Chinese guidance and offers the settings pane only for a desktop denial", () => {
    expect(microphoneGuidance("denied", "darwin")).toContain("系统设置 → 隐私与安全性 → 麦克风");
    expect(microphoneGuidance("denied", "darwin")).toContain("「同频」");
    expect(microphoneGuidance("denied", "win32")).toContain("Windows 设置 → 隐私和安全性");
    expect(microphoneGuidance("denied", "win32")).toContain("麦克风");
    expect(microphoneGuidance("denied", "")).toContain("浏览器");
    expect(microphoneGuidance("no-device", "darwin")).toContain("没有检测到");
    expect(microphoneIssue("denied", "darwin", true).canOpenSettings).toBe(true);
    expect(microphoneIssue("denied", "win32", true).canOpenSettings).toBe(true);
    expect(microphoneIssue("denied", "darwin", false).canOpenSettings).toBe(false);
    expect(microphoneIssue("busy", "darwin", true).canOpenSettings).toBe(false);
    expect(microphoneIssue("denied", "linux", true).canOpenSettings).toBe(false);
  });
});

describe("voice preferences", () => {
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
  };

  it("persists per account and normalizes unknown values", () => {
    const storage = memoryStorage();
    writeVoicePreferences("member-a", { conversationMode: true, autoSend: false, autoRead: true, rate: 1.25 }, storage);
    expect(readVoicePreferences("member-a", storage)).toEqual({ conversationMode: true, autoSend: false, autoRead: true, rate: 1.25 });
    expect(readVoicePreferences("member-b", storage)).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(voicePreferencesKey(undefined)).toBe("tongpin.ai.voice.v1:guest");
    storage.values.set(voicePreferencesKey("member-c"), "{not json");
    expect(readVoicePreferences("member-c", storage)).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(normalizeVoicePreferences({ rate: 3, autoSend: "yes", conversationMode: 1 })).toEqual(DEFAULT_VOICE_PREFERENCES);
  });

  it("survives storage that throws and still notifies listeners", () => {
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(readVoicePreferences("member", throwing)).toEqual(DEFAULT_VOICE_PREFERENCES);
    const listener = vi.fn();
    const unsubscribe = subscribeVoicePreferences(listener);
    expect(() => writeVoicePreferences("member", { ...DEFAULT_VOICE_PREFERENCES, autoRead: true }, throwing)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    writeVoicePreferences("member", DEFAULT_VOICE_PREFERENCES, throwing);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("makes conversation mode imply auto-send, auto-read and stop-on-silence", () => {
    expect(effectiveVoicePreferences(DEFAULT_VOICE_PREFERENCES)).toEqual({ autoSend: false, autoRead: false, stopOnSilence: false });
    expect(effectiveVoicePreferences({ ...DEFAULT_VOICE_PREFERENCES, autoRead: true })).toEqual({ autoSend: false, autoRead: true, stopOnSilence: false });
    expect(effectiveVoicePreferences({ ...DEFAULT_VOICE_PREFERENCES, conversationMode: true })).toEqual({ autoSend: true, autoRead: true, stopOnSilence: true });
  });
});
