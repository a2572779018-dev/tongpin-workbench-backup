import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("./AiVideoComposer.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("conversational tool planning boundary", () => {
  it("uses only chat preflight and chat inference for image, video and PPT planning", () => {
    const planning = section(page, 'async function planTool(', 'async function sendVideo(');
    expect(planning).toContain('kind === "presentation" ? "presentation_plan" : "image_plan"');
    expect(planning).toContain('api<AiChatPreflight>("/api/ai/preflight"');
    expect(planning).toContain('api<AiChatResponse>("/api/ai/chat"');
    expect(planning).not.toContain('"/api/ai/images"');
    expect(planning).not.toContain('"/api/ai/videos"');
    expect(planning).not.toContain('"/api/ai/video-references"');
    expect(planning).toContain("planRequestId: response.requestId");
  });

  it("returns after the first video click and invokes generation only after a visible plan exists", () => {
    const submit = section(composer, "async function submit()", "useImperativeHandle");
    const planBranch = section(submit, "if (!plan)", "setSubmitted(true)");
    expect(planBranch).toContain("await onPlan(base)");
    expect(planBranch).toContain("return;");
    expect(planBranch).not.toContain("await onSubmit(");
    expect(submit.indexOf("await onPlan(base)")).toBeLessThan(submit.indexOf("await onSubmit("));
    expect(composer).toContain('{plan ? "\u786e\u8ba4\u751f\u6210" : "\u8ba9\u540c\u9891 AI \u6574\u7406"}');
  });

  it("returns after the first image or PPT click and passes only an approved plan to generation", () => {
    const submit = section(workspace, "function submitMessage(", "async function addFiles(");
    const inferredRoute = section(submit, 'if ((requestedTool === "image"', 'if ((!draft.trim()');
    expect(inferredRoute).toContain("setQueuedToolPlan({ kind: pendingPlanKind, originalPrompt, contextKey: toolPlanContextKeyFor(targetComposerTool) })");
    expect(inferredRoute).toContain("onComposerToolChange?.(targetComposerTool)");
    expect(inferredRoute).toContain("return;");
    expect(inferredRoute).not.toContain("onSubmit(");
    const queuedPlanning = section(workspace, "if (!queuedToolPlan) return;", "if (quickAuto");
    expect(queuedPlanning).toContain("if (composerTool !== targetTool) return;");
    expect(queuedPlanning).toContain("beginToolPlan(queuedToolPlan.kind, queuedToolPlan.originalPrompt, queuedToolPlan.contextKey)");
    const planBranch = section(submit, "if (pendingPlanKind && !approvedPlan)", "followResponseRef.current");
    expect(planBranch).toContain("const originalPrompt = draft.trim()");
    expect(planBranch).toContain("beginToolPlan(pendingPlanKind, originalPrompt, toolPlanContextKey)");
    expect(planBranch).toContain("return;");
    expect(planBranch).not.toContain("onSubmit(");
    expect(submit).toContain("onSubmit(imagePlan ?? presentationPlan ?? undefined)");
    const imageSend = section(page, "async function sendMessage(", "async function retryReply");
    expect(imageSend).toContain('composerTool === "image" && (!approvedPlan || approvedPlan.kind !== "image")');
    expect(imageSend).toContain("prompt: approvedPlan!.prompt");
    expect(imageSend).toContain("planRequestId: approvedPlan!.planRequestId");
    expect(imageSend).toContain('composerTool === "presentation" && (!approvedPlan || approvedPlan.kind !== "presentation"');
    expect(imageSend).toContain("content: approvedPlan.prompt");
    expect(imageSend).toContain("toolPlanRequestId: approvedPlan!.planRequestId");
  });

  it("requires a bound video plan before persisting, uploading references or posting generation", () => {
    const send = section(page, "async function sendVideo(", "async function useVideoHistory(");
    const guard = send.indexOf("!request.planRequestId");
    expect(guard).toBeGreaterThanOrEqual(0);
    for (const operation of ["saveNow(next)", '"/api/ai/video-references"', '"/api/ai/videos"']) {
      expect(guard).toBeLessThan(send.indexOf(operation));
    }
  });
});
