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
    const planning = section(page, 'async function planTool(', 'function recordMediaTask(');
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
    expect(submit.indexOf("onSubmitTask({ ...base")).toBeLessThan(submit.indexOf("await onPlan(base)"));
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

  it("routes direct image/video creation to one durable task and keeps legacy PPT planning", () => {
    const begin = section(workspace, "const beginToolPlan", "useEffect(() => {");
    expect(begin).toContain("onPlanTool(kind, originalPrompt).then(plan =>");
    expect(begin).toContain("if (!plan) return;");
    expect(begin).toContain("onSubmit(confirmed)");
    expect(begin.indexOf("if (!plan) return;")).toBeLessThan(begin.indexOf("onSubmit(confirmed)"));
    const submit = section(workspace, "function submitMessage(", "async function addFiles(");
    const explicitRoute = section(submit, 'if (onSubmitTool && requestedTool === "video"', 'if ((!draft.trim()');
    expect(explicitRoute).toContain('onSubmitTool("video", draft.trim()');
    expect(explicitRoute).toContain('onSubmitTool(pendingPlanKind, draft.trim()');
    expect(explicitRoute).not.toContain("onSubmit(");
    expect(submit).toContain("requestedTool");
    const queuedPlanning = section(workspace, "if (!queuedToolPlan) return;", "if (quickAuto");
    expect(queuedPlanning).toContain("if (composerTool !== targetTool) return;");
    expect(queuedPlanning).toContain("beginToolPlan(queuedToolPlan.kind, queuedToolPlan.originalPrompt, queuedToolPlan.contextKey)");
    const planBranch = section(submit, "if (pendingPlanKind)", "    onSubmit();");
    expect(planBranch).toContain("const originalPrompt = draft.trim()");
    expect(planBranch).toContain('onSubmitTool(pendingPlanKind, originalPrompt, "menu")');
    expect(planBranch).toContain("return;");
    expect(planBranch).not.toContain("onSubmit(");
    expect(submit).toContain("onSubmit()");
    expect(workspace).not.toContain('className="tp-ai-tool-plan"');
    expect(workspace).not.toContain("让同频 AI 整理图片任务");
    expect(workspace).not.toContain("确认生成图片");
    const media = section(page, "async function submitMediaTask(", "async function sendVideo(");
    expect(media.indexOf("saveNow(next)")).toBeLessThan(media.indexOf('"/api/ai/media-tasks"'));
    expect(media.indexOf("saveNow(next)")).toBeLessThan(media.indexOf('"/api/ai/video-references"'));
    expect(media).toContain('sourceAssetIds = origin.attachments.length ? origin.attachments.map(item => item.id) : priorImageIds');
    expect(media).toContain('continuation ? { ...currentState, conversations: latest.conversations.map');
    expect(media).toContain('let maxPointsPerTool = continuation ? undefined');
    expect(media).toContain("confirmedMediaExecution: { confirmed: true, maxPointsPerTool }");
    expect(media).toContain('`/api/ai/media-tasks/by-request/${encodeURIComponent(requestId)}`');
    expect(media).not.toContain('"/api/ai/images"');
    expect(media).not.toContain('"/api/ai/videos"');
    const imageSend = section(page, "async function sendMessage(", "async function retryReply");
    expect(imageSend).toContain('generationTool === "presentation" && (!approvedPlan || approvedPlan.kind !== "presentation"');
    expect(imageSend).toContain("content: approvedPlan.prompt");
    expect(imageSend).toContain("toolPlanRequestId: approvedPlan!.planRequestId");
    const dispatch = section(page, 'if (!("images" in response) && response.dispatch)', "acceptGeneration(conversationId, messageId, response");
    expect(dispatch).toContain('decision.kind === "text" || decision.clarification');
    expect(dispatch).toContain('await submitMediaTask(decision.kind, originalPrompt, undefined, "natural", undefined, continuation)');
    expect(dispatch).toContain('if (decision.kind === "presentation")');
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
    expect(send.indexOf("saveNow(next)")).toBeLessThan(send.indexOf('"/api/ai/video-references"'));
    expect(send.indexOf('"/api/ai/video-references"')).toBeLessThan(send.indexOf("saveNow(preparedState)"));
    expect(send.indexOf("saveNow(preparedState)")).toBeLessThan(send.indexOf('"/api/ai/videos"'));
    expect(send).toContain("attachments: origin.attachments");
  });
});
