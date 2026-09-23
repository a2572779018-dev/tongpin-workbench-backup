import { describe, expect, it } from "vitest";
import type { AiWorkspaceState } from "../../../shared/aiWorkspace";
import { preserveVideoClarificationDraft } from "./videoDraftRecovery";

const state = (): AiWorkspaceState => ({
  view: "chat", mode: "quick", conversations: [], projects: [], artifacts: [],
  drafts: { other: "保留" }, draftAttachments: {}, videoDraftSettings: {},
  activeConversationId: null, activeProjectId: null, enabledSkillIds: [],
});

describe("video clarification draft recovery", () => {
  it("restores the original video with all samples and its selected source time", () => {
    const initial = state();
    const video = { id: "source", name: "actor.mp4", mimeType: "video/mp4", content: "sampled only", media: { kind: "video" as const, durationSeconds: 9, selectedFrameIndex: 1, frames: [{ timeSeconds: 0.001, dataUrl: "data:image/jpeg;base64,YQ==" }, { timeSeconds: 4.5, dataUrl: "data:image/jpeg;base64,Yg==" }] } };
    initial.conversations = [{ id: "a", title: "A", timeLabel: "", messages: [{ id: "message", role: "user", content: "use selected frame", time: "", attachments: [video] }] }];
    const next = preserveVideoClarificationDraft(initial, "a", "补充", { requestId: "request", prompt: "补充", seconds: 6, resolution: "768p", aspectRatio: "16:9", referenceImages: [{ name: "actor.mp4 · 4.50 秒", dataUrl: "data:image/jpeg;base64,Yg==", sourceVideo: { documentId: "source", name: "actor.mp4", timeSeconds: 4.5 } }] });
    expect(next.draftAttachments?.a).toEqual([video]);
  });
  it("keeps the exact editable inputs and references without persisting execution authorization", () => {
    const next = preserveVideoClarificationDraft(state(), "conversation-a", "请做品牌短片", {
      requestId: "local-request", planRequestId: "single-use-plan", planTrace: {
        runId: "run-a", tier: "quick", strategy: "plan_execute", status: "planned",
        reasoningSummary: "public", nextAction: "resume", toolBudget: { used: 1, max: 3, remaining: 2 }, steps: [],
      },
      prompt: "请做品牌短片", model: "sd-2-c6", seconds: 10, resolution: "720p", aspectRatio: "9:16",
      referenceIds: ["provider-reference"],
      referenceImages: [{ name: "logo.png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
    });
    expect(next.drafts).toEqual({ other: "保留", "conversation-a": "请做品牌短片" });
    expect(next.videoDraftSettings?.["conversation-a"]).toEqual({ model: "sd-2-c6", seconds: 10, resolution: "720p", aspectRatio: "9:16" });
    expect(next.draftAttachments?.["conversation-a"]).toEqual([
      expect.objectContaining({ name: "logo.png", mimeType: "image/png", media: { kind: "image", frames: [{ dataUrl: "data:image/png;base64,aGVsbG8=" }] } }),
    ]);
    const serializedDraft = JSON.stringify({
      settings: next.videoDraftSettings?.["conversation-a"],
      attachments: next.draftAttachments?.["conversation-a"],
    });
    expect(serializedDraft).not.toContain("single-use-plan");
    expect(serializedDraft).not.toContain("provider-reference");
    expect(serializedDraft).not.toContain("plan_execute");
  });

  it("replaces stale reference drafts and preserves another conversation", () => {
    const initial = state();
    initial.draftAttachments = {
      "conversation-a": [{ id: "stale", name: "stale.png", mimeType: "image/png", content: "", media: { kind: "image", frames: [{ dataUrl: "data:image/png;base64,b2xk" }] } }],
      other: [{ id: "other", name: "other.png", mimeType: "image/png", content: "", media: { kind: "image", frames: [{ dataUrl: "data:image/png;base64,b3RoZXI=" }] } }],
    };
    const next = preserveVideoClarificationDraft(initial, "conversation-a", "继续补充", {
      requestId: "local", prompt: "继续补充", seconds: 6, resolution: "768p", aspectRatio: "16:9",
    });
    expect(next.draftAttachments).not.toHaveProperty("conversation-a");
    expect(next.draftAttachments?.other).toBe(initial.draftAttachments.other);
    expect(next.videoDraftSettings?.["conversation-a"]).toEqual({ seconds: 6, resolution: "768p", aspectRatio: "16:9" });
  });
});
