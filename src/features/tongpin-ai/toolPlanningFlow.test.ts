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
    expect(planning).toContain("response.toolClarification?.trim()");
    expect(planning).toContain('content: clarification, status: "ready"');
    expect(planning).toContain("persistenceRef.current.saveNow(next)");
    expect(planning).toContain("preserveVideoClarificationDraft(state, conversationId, prompt, videoRequest)");
    expect(planning).toContain("setVideoDraftSettings(next.videoDraftSettings ?? {})");
    expect(planning).toContain("setVideoDispatchRequest({ id: crypto.randomUUID(), conversationId, prompt, request: videoRequest })");
    expect(planning.indexOf("if (clarification)")).toBeLessThan(planning.indexOf("if (!response.toolPlan"));
  });

  it("uses one explicit video send to plan first and then submit that server-issued plan", () => {
    const submit = section(composer, "async function submit()", "useImperativeHandle");
    const planBranch = section(submit, "if (!approvedPlan)", "setSubmitted(true)");
    expect(planBranch).toContain("await onPlan(base)");
    expect(planBranch).not.toContain("await onSubmit(");
    expect(submit.indexOf("await onPlan(base)")).toBeLessThan(submit.indexOf("await onSubmit("));
    expect(submit).toContain("planRequestId: approvedPlan.planRequestId");
    expect(composer).not.toContain("让同频 AI 整理");
    expect(composer).not.toContain("确认生成");
    expect(composer).toContain('busy ? <p role="status">{busyLabel');
    expect(workspace).toContain('videoOpen ? videoBusy ? "正在整理并提交视频任务" : "生成视频"');
    expect(workspace).toContain("openVideoComposer(videoDispatchRequest.request)");
    expect(page).toContain('id: `video-draft:${draftKey}`');
  });

  it("uses one image or PPT send to plan then execute, while null plans remain clarification-only", () => {
    const begin = section(workspace, "const beginToolPlan", "useEffect(() => {");
    expect(begin).toContain("onPlanTool(kind, originalPrompt).then(plan =>");
    expect(begin).toContain("if (!plan) return;");
    expect(begin).toContain("onSubmit(confirmed)");
    expect(begin.indexOf("if (!plan) return;")).toBeLessThan(begin.indexOf("onSubmit(confirmed)"));
    const submit = section(workspace, "function submitMessage(", "async function addFiles(");
    const explicitRoute = section(submit, 'if ((mentionedTools[0] === "image"', 'if ((!draft.trim()');
    expect(explicitRoute).toContain("setQueuedToolPlan({ kind: pendingPlanKind, originalPrompt, contextKey: toolPlanContextKeyFor(targetComposerTool) })");
    expect(explicitRoute).toContain("onComposerToolChange?.(targetComposerTool)");
    expect(explicitRoute).toContain("return;");
    expect(explicitRoute).not.toContain("onSubmit(");
    expect(submit).not.toContain("requestedTool");
    const queuedPlanning = section(workspace, "if (!queuedToolPlan) return;", "if (quickAuto");
    expect(queuedPlanning).toContain("if (composerTool !== targetTool) return;");
    expect(queuedPlanning).toContain("beginToolPlan(queuedToolPlan.kind, queuedToolPlan.originalPrompt, queuedToolPlan.contextKey)");
    const planBranch = section(submit, "if (pendingPlanKind)", "followResponseRef.current");
    expect(planBranch).toContain("const originalPrompt = draft.trim()");
    expect(planBranch).toContain("beginToolPlan(pendingPlanKind, originalPrompt, toolPlanContextKey)");
    expect(planBranch).toContain("return;");
    expect(planBranch).not.toContain("onSubmit(");
    expect(submit).toContain("onSubmit()");
    expect(workspace).not.toContain('className="tp-ai-tool-plan"');
    expect(workspace).not.toContain("让同频 AI 整理图片任务");
    expect(workspace).not.toContain("确认生成图片");
    const imageSend = section(page, "async function sendMessage(", "async function retryReply");
    expect(imageSend).toContain('generationTool === "image" && (!approvedPlan || approvedPlan.kind !== "image")');
    expect(imageSend).toContain("prompt: approvedPlan!.prompt");
    expect(imageSend).toContain("planRequestId: approvedPlan!.planRequestId");
    expect(imageSend).toContain('generationTool === "presentation" && (!approvedPlan || approvedPlan.kind !== "presentation"');
    expect(imageSend).toContain("content: approvedPlan.prompt");
    expect(imageSend).toContain("toolPlanRequestId: approvedPlan!.planRequestId");
    expect(imageSend).toContain('generationTool === "text" ? "dispatch"');
    const dispatch = section(page, 'if (!("images" in response) && response.dispatch)', "acceptGeneration(conversationId, messageId, response");
    expect(dispatch).toContain('decision.kind === "text" || decision.clarification');
    expect(dispatch).toContain("await planTool(decision.kind, decision.prompt, undefined, continuation)");
    expect(dispatch).toContain("await sendMessage({ ...plan, originalPrompt }, continuation)");
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
