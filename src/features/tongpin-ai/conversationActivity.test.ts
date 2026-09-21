import { describe, expect, it } from "vitest";
import { hasConversationActivity } from "./conversationActivity";

describe("conversation-scoped reply activity", () => {
  it("does not block a second conversation while the first request is running", () => {
    const requests = new Map<string, unknown>([["conversation-a", {}]]);
    expect(hasConversationActivity("conversation-a", {}, requests, new Set(), new Map())).toBe(true);
    expect(hasConversationActivity("conversation-b", {}, requests, new Set(), new Map())).toBe(false);
  });

  it("treats pending persistence and typewriter work as busy only for their owner", () => {
    const pending = new Set(["conversation-a"]);
    const typing = new Map<string, unknown>([["conversation-b", {}]]);
    expect(hasConversationActivity("conversation-a", {}, new Map(), pending, typing)).toBe(true);
    expect(hasConversationActivity("conversation-b", {}, new Map(), pending, typing)).toBe(true);
    expect(hasConversationActivity("conversation-c", {}, new Map(), pending, typing)).toBe(false);
  });
});
