import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
  shouldPlayNotificationSound,
}: {
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS: number;
  shouldPlayNotificationSound(options: {
    enabled: boolean;
    soundKey: string;
    lastPlayedAt?: number;
    now?: number;
    dedupMs?: number;
  }): boolean;
} = require("../../electron/notification-sound-policy.cjs");

describe("desktop notification sound policy", () => {
  it("plays a bell for an enabled boss notification", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "boss-notification:notice-1:0",
        now: 10_000,
      }),
    ).toBe(true);
  });

  it("suppresses the same notification during the short duplicate window", () => {
    expect(DEFAULT_NOTIFICATION_SOUND_DEDUP_MS).toBe(2_000);
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "boss-notification:notice-1:0",
        lastPlayedAt: 10_000,
        now: 11_999,
      }),
    ).toBe(false);
  });

  it("allows a later reminder to ring again", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: true,
        soundKey: "boss-notification:notice-1:0",
        lastPlayedAt: 10_000,
        now: 12_000,
      }),
    ).toBe(true);
  });

  it("never rings without an explicit sound request and stable key", () => {
    expect(
      shouldPlayNotificationSound({
        enabled: false,
        soundKey: "boss-notification:notice-1:0",
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
});
