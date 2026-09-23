import { describe, expect, it } from "vitest";
import { captureSubmission, mergeContinuation } from "./submissionSnapshot";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";
const emptyWorkspaceState = () => serializeWorkspace(hydrateWorkspace(null));

describe("immutable submitted conversation ownership", () => {
  it("snapshots A's model, project, references and skills before switching to B", () => {
    const input = { conversationId: "a", draftKey: "a", conversation: { id: "a", title: "A", timeLabel: "", messages: [] }, project: { id: "p", title: "P", timeLabel: "", instructions: "A context" }, attachments: [{ id: "ref", name: "A.txt", mimeType: "text/plain", content: "A reference" }], mode: "deep" as const, skillIds: ["writing"], webSearch: false };
    const task = captureSubmission(input);
    input.project.instructions = "B context"; input.attachments[0].content = "B reference"; input.skillIds.push("other");
    expect(task.project?.instructions).toBe("A context");
    expect(task.attachments[0].content).toBe("A reference");
    expect(task.skillIds).toEqual(["writing"]);
  });
  it("A finishes while B is focused without changing B's draft, attachments or view", () => {
    const a = { id: "a", title: "A", timeLabel: "", messages: [] };
    const b = { id: "b", title: "B", timeLabel: "", messages: [] };
    const latest = { ...emptyWorkspaceState(), conversations: [a, b], activeConversationId: "b", drafts: { b: "unfinished B" }, draftAttachments: { b: [{ id: "b-doc", name: "B.txt", content: "B", mimeType: "text/plain" }] } };
    const next = mergeContinuation(latest, { ...a, messages: [{ id: "reply", role: "assistant", content: "A result", time: "" }] });
    expect(next.activeConversationId).toBe("b"); expect(next.view).toBe(latest.view);
    expect(next.drafts).toBe(latest.drafts); expect(next.draftAttachments).toBe(latest.draftAttachments);
    expect(next.conversations[1]).toBe(b); expect(next.conversations[0].messages[0].content).toBe("A result");
  });
  it("does not resurrect a deleted conversation when its planner finishes", () => {
    const state = emptyWorkspaceState();
    expect(mergeContinuation(state, { id: "deleted", title: "A", timeLabel: "", messages: [] })).toBe(state);
  });
});
