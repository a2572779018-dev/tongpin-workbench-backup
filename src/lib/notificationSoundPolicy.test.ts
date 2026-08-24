import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CUSTOM_NOTIFICATION_SOUND_PREFIX,
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
  isCustomNotificationSoundKey,
  shouldPlayNotificationSound,
  shouldUseCustomNotificationSound,
}: {
  CUSTOM_NOTIFICATION_SOUND_PREFIX: string;
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS: number;
  isCustomNotificationSoundKey(soundKey: unknown): boolean;
  shouldPlayNotificationSound(options: {
    enabled: boolean;
    soundKey: string;
    lastPlayedAt?: number;
    now?: number;
    dedupMs?: number;
  }): boolean;
  shouldUseCustomNotificationSound(payload: unknown): boolean;
} = require("../../electron/notification-sound-policy.cjs");

describe("desktop notification sound policy", () => {
  it("recognizes an enabled boss reminder as custom notice audio", () => {
    expect(CUSTOM_NOTIFICATION_SOUND_PREFIX).toBe("boss-notification:");
    expect(isCustomNotificationSoundKey("boss-notification:notice-1:0")).toBe(
      true,
    );
    expect(
      shouldUseCustomNotificationSound({
        playSound: true,
        requireAcknowledgement: true,
        soundKey: "boss-notification:notice-1:0",
      }),
    ).toBe(true);
    expect(
      shouldPlayNotificationSound({
        enabled: false,
        soundKey: "boss-notification:notice-1:0",
        now: 10_000,
      }),
    ).toBe(false);
  });

  it("keeps the fallback sound available when no custom player was selected", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "boss-notification:notice-ordinary:0",
        now: 10_000,
      }),
    ).toBe(true);
  });

  it("suppresses the same fallback sound during the short duplicate window", () => {
    expect(DEFAULT_NOTIFICATION_SOUND_DEDUP_MS).toBe(2_000);
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "fallback-notification:notice-1:0",
        lastPlayedAt: 10_000,
        now: 11_999,
      }),
    ).toBe(false);
  });

  it("allows a later reminder to ring again", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "fallback-notification:notice-1:0",
        lastPlayedAt: 10_000,
        now: 12_000,
      }),
    ).toBe(true);
  });

  it("never rings without an explicit sound request and stable key", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: false,
        soundKey: "fallback-notification:notice-1:0",
        now: 10_000,
      }),
    ).toBe(false);
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "",
        now: 10_000,
      }),
    ).toBe(false);
  });

  it("does not use the custom sound for ordinary or unacknowledged notices", () => {
    expect(
      shouldUseCustomNotificationSound({
        playSound: true,
        requireAcknowledgement: false,
        soundKey: "boss-notification:notice-1:0",
      }),
    ).toBe(false);
    expect(
      shouldUseCustomNotificationSound({
        playSound: true,
        requireAcknowledgement: true,
        soundKey: "fallback-notification:notice-1:0",
      }),
    ).toBe(false);
  });
});
