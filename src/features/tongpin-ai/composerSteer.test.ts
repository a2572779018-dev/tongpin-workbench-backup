import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiHarnessTrace } from "../../../shared/ai";
import { ChatWorkspace } from "./ChatWorkspace";
import {
  appendDraftText, awaitingUserConfirmation, COMPOSER_STEER_LABELS, composerHintText, composerSendMode, draftAfterSend,
  escapeStopsReply, latestAssistantMessage, mergeSteerTexts, steerBubbles, steerDeliveryTarget, steerRunActive,
  STEER_STATUS_LABELS, supplementBlockReason, type SteerItem,
} from "./composerSteer";
import { shouldStopReplyOnEscape, type StopReplyEnvironment, type StopReplyKeyEvent } from "./stopReplyShortcut";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";

const trace = (overrides: Partial<AiHarnessTrace> = {}): AiHarnessTrace => ({
  runId: "run", tier: "quick", strategy: "react", status: "running", reasoningSummary: "进行中", nextAction: "poll",
  toolBudget: { used: 1, max: 3, remaining: 2 }, steps: [], ...overrides,
});
const reply = (overrides: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({
  id: "assistant-1", role: "assistant", content: "", time: "12:00", status: "thinking", requestId: "request-0000000000000001", ...overrides,
});

describe("composer send button state machine", () => {
  it("is a send button when idle, a spinner while running with an empty composer, and a supplement button once text is typed", () => {
    expect(composerSendMode({ responding: false, draft: "", steerAvailable: true })).toBe("send");
    expect(composerSendMode({ responding: false, draft: "新问题", steerAvailable: false })).toBe("send");
    expect(composerSendMode({ responding: true, draft: "", steerAvailable: true })).toBe("stop");
    expect(composerSendMode({ responding: true, draft: " \n\t ", steerAvailable: true })).toBe("stop");
    expect(composerSendMode({ responding: true, draft: "改成三页", steerAvailable: true })).toBe("steer");
    // No steering (e.g. a confirmation card waits): the running task keeps the stop spinner.
    expect(composerSendMode({ responding: true, draft: "改成三页", steerAvailable: false })).toBe("stop");
  });

  it("lets Esc stop only a running reply whose composer is empty", () => {
    expect(escapeStopsReply({ canStop: true, draft: "" })).toBe(true);
    expect(escapeStopsReply({ canStop: true, draft: "   " })).toBe(true);
    expect(escapeStopsReply({ canStop: true, draft: "纠正一下" })).toBe(false);
    expect(escapeStopsReply({ canStop: false, draft: "" })).toBe(false);
    const key: StopReplyKeyEvent = { key: "Escape", defaultPrevented: false, isComposing: false, keyCode: 27, repeat: false,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: null };
    const environment: StopReplyEnvironment = { root: { contains: () => true }, activeElement: null, body: null, documentElement: null, modalOpen: false, popupOpen: false };
    expect(shouldStopReplyOnEscape(key, environment)).toBe(true);
    expect(shouldStopReplyOnEscape(key, { ...environment, composerHasText: false })).toBe(true);
    expect(shouldStopReplyOnEscape(key, { ...environment, composerHasText: true })).toBe(false);
  });

  it("explains the current keys", () => {
    expect(composerHintText({ responding: true, steerAvailable: true, draft: "", escapeStops: true })).toBe("按 Esc 停止当前回复 · 也可直接输入补充或纠正");
    expect(composerHintText({ responding: true, steerAvailable: true, draft: "补充", escapeStops: false })).toBe("Enter 发送补充，不会打断当前回复");
    expect(composerHintText({ responding: true, steerAvailable: false, draft: "", escapeStops: true })).toBe("按 Esc 停止当前回复");
    expect(composerHintText({ responding: false, steerAvailable: true, draft: "", escapeStops: false })).toBe("Enter 发送 · Shift + Enter 换行");
  });
});

describe("supplement queue helpers", () => {
  const item = (id: string, text: string, createdAt: number, overrides: Partial<SteerItem> = {}): SteerItem => ({ id, conversationId: "c", text, createdAt, status: "queued", ...overrides });

  it("merges supplements oldest first into one follow-up text", () => {
    expect(mergeSteerTexts([item("b", " 第二条 ", 2), item("a", "第一条", 1), item("c", "  ", 3)])).toBe("第一条\n第二条");
  });

  it("puts returned text after the member's newer draft and clears only what a send used", () => {
    expect(appendDraftText(undefined, "补充")).toBe("补充");
    expect(appendDraftText("  ", "补充")).toBe("补充");
    expect(appendDraftText("新的问题\n", "补充")).toBe("新的问题\n补充");
    expect(draftAfterSend("你好", "你好")).toBe("");
    expect(draftAfterSend("你好 再补一句", "你好")).toBe("再补一句");
    expect(draftAfterSend("另起一段", "你好")).toBe("另起一段");
  });

  it("shows bubbles without withdrawn items and only lets settled ones be cancelled", () => {
    expect(steerBubbles([
      item("a", "排队", 1), item("b", "发送中", 2, { status: "sending" }), item("c", "交付中", 3, { delivering: true }),
      item("d", "已交给", 4, { status: "handed", runRequestId: "run" }), item("e", "撤回", 5, { withdrawn: true }),
    ])).toEqual([
      { id: "a", text: "排队", status: "queued", cancellable: true },
      { id: "b", text: "发送中", status: "sending", cancellable: false },
      { id: "c", text: "交付中", status: "queued", cancellable: false },
      { id: "d", text: "已交给", status: "handed", cancellable: true },
    ]);
    expect(STEER_STATUS_LABELS).toEqual({ queued: "等当前回复结束后自动发送", sending: "正在发送…", handed: "已交给 AI" });
  });

  it("finds the newest assistant message", () => {
    const messages: TongpinAIMessage[] = [reply({ id: "a1" }), { id: "u1", role: "user", content: "q", time: "12:00" }, reply({ id: "a2" }), { id: "u2", role: "user", content: "q", time: "12:01" }];
    expect(latestAssistantMessage(messages)?.id).toBe("a2");
    expect(latestAssistantMessage([])).toBeUndefined();
    expect(latestAssistantMessage(undefined)).toBeUndefined();
  });
});

describe("delivery target", () => {
  it("hands guidance only to an active multi-step run that will make another step", () => {
    expect(steerDeliveryTarget(reply({ trace: trace() }))).toEqual({ kind: "guidance", runRequestId: "request-0000000000000001" });
    // A PPT execution reports progress on its parent plan run.
    expect(steerDeliveryTarget(reply({ trace: trace({ status: "waiting_approval" }), harnessPlanRequestId: "plan-000000000000000001" }))).toEqual({ kind: "guidance", runRequestId: "plan-000000000000000001" });
    expect(steerDeliveryTarget(reply({ trace: trace({ strategy: "plan_execute", status: "planned" }) })).kind).toBe("guidance");
    for (const message of [
      undefined, reply(), reply({ trace: trace({ strategy: "direct" }) }), reply({ trace: trace({ toolBudget: { used: 3, max: 3, remaining: 0 } }) }),
      reply({ trace: trace({ status: "succeeded" }) }), reply({ trace: trace({ status: "failed" }) }), reply({ trace: trace({ status: "cancelled" }) }),
      { ...reply({ trace: trace() }), role: "user" as const },
    ]) expect(steerDeliveryTarget(message)).toEqual({ kind: "followup" });
    expect(steerRunActive([reply({ trace: trace() })], "request-0000000000000001")).toBe(true);
    expect(steerRunActive([reply({ trace: trace({ status: "succeeded" }) })], "request-0000000000000001")).toBe(false);
    expect(steerRunActive(undefined, "request-0000000000000001")).toBe(false);
  });

  it("switches steering off while a confirmation card waits for the member", () => {
    const media = (status: string, extra: Record<string, unknown> = {}): TongpinAIArtifact => ({ id: "art", conversationId: "c", title: "图", kind: "图片", updatedLabel: "刚刚", summary: "", sections: [], data: { mediaTaskRequestId: "request-0000000000000001", mediaTaskStatus: status, ...extra } });
    const selection: TongpinAIArtifact = { id: "sel", conversationId: "c", title: "选择", kind: "参考图片选择", updatedLabel: "刚刚", summary: "", sections: [], data: {
      generatedImageSelection: { requestId: "request-0000000000000001", sourceArtifactId: "artifact-000001", assetIds: ["asset-00000001", "asset-00000002"], mode: "quick", entrypoint: "natural", status: "awaiting_selection" },
    } };
    const done = reply({ status: "ready", content: "" });
    expect(awaitingUserConfirmation(done, media("awaiting_authorization"))).toBe(true);
    expect(awaitingUserConfirmation(done, media("awaiting_input"))).toBe(true);
    expect(awaitingUserConfirmation(done, media("awaiting_authorization", { mediaTaskSubmitError: "未提交" }))).toBe(false);
    expect(awaitingUserConfirmation(done, media("running"))).toBe(false);
    expect(awaitingUserConfirmation(done, selection)).toBe(true);
    expect(awaitingUserConfirmation(reply({ taskPhase: "awaiting_authorization" }))).toBe(true);
    // A clarifying question is answered by typing, not by a card.
    expect(awaitingUserConfirmation(reply({ taskPhase: "awaiting_input" }))).toBe(false);
    expect(awaitingUserConfirmation(undefined)).toBe(false);
  });

  it("names why a queued follow-up must go back to the composer", () => {
    const ok = { onboarded: true, serviceConnected: true, connectionError: false, availabilityBlocked: false, quotaInsufficient: false, syncBlocked: false, computerActive: false, awaitingConfirmation: false };
    expect(supplementBlockReason(ok)).toBeUndefined();
    expect(supplementBlockReason({ ...ok, serviceConnected: false })).toContain("AI 服务暂不可用");
    expect(supplementBlockReason({ ...ok, availabilityBlocked: true })).toContain("AI 服务暂不可用");
    expect(supplementBlockReason({ ...ok, quotaInsufficient: true })).toContain("额度不足");
    expect(supplementBlockReason({ ...ok, syncBlocked: true })).toContain("尚未同步");
    expect(supplementBlockReason({ ...ok, computerActive: true })).toContain("电脑操作");
    expect(supplementBlockReason({ ...ok, awaitingConfirmation: true })).toContain("等你确认");
    for (const key of ["serviceConnected", "quotaInsufficient", "syncBlocked", "computerActive", "awaitingConfirmation"] as const) {
      expect(supplementBlockReason({ ...ok, [key]: key === "serviceConnected" ? false : true })).toContain("已放回输入框");
    }
  });
});

describe("composer rendering while a reply runs", () => {
  const noop = () => undefined;
  const user: TongpinAIMessage = { id: "u", role: "user", content: "写一份周报", time: "12:00" };
  const props = {
    artifactById: new Map(), composerFocusRequest: 0, enabledSkills: [], mode: "quick" as const, notificationUnread: 0,
    quotaInsufficient: false, serviceConnected: true, onDraftChange: noop, onModeChange: noop, onOpenArtifact: noop, onSubmit: noop, onStop: noop,
    messages: [user, reply({ startedAt: Date.now() })], responding: true, draft: "",
  };
  const render = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ChatWorkspace, { ...props, ...overrides }));

  it("shows a stop spinner for an empty composer and never disables typing", () => {
    const markup = render({ onSteer: () => true });
    expect(markup).toContain(`aria-label="${COMPOSER_STEER_LABELS.stop}"`);
    expect(markup).toContain('title="停止（Esc）"');
    expect(markup).toContain('aria-keyshortcuts="Escape"');
    expect(markup).toContain('data-state="stop"');
    expect(markup).toContain('class="tp-ai-send-button__ring"');
    expect(markup).not.toContain(COMPOSER_STEER_LABELS.steer);
    const textarea = /<textarea[^>]*id="tp-ai-message-input"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(textarea).not.toMatch(/disabled|readonly/i);
    expect(markup).toContain("按 Esc 停止当前回复 · 也可直接输入补充或纠正");
  });

  it("turns the spinner back into a send button once text is typed, without Esc stopping", () => {
    const markup = render({ onSteer: () => true, draft: "改成英文" });
    expect(markup).toContain(`aria-label="${COMPOSER_STEER_LABELS.steer}"`);
    expect(markup).toMatch(/<button type="submit" class="tp-ai-send-button is-steer" data-state="steer"/);
    // The ring stays in the button (so it can fade out) but only stop/busy show and turn it.
    expect(markup).not.toContain('data-state="stop"');
    expect(markup).not.toContain('aria-keyshortcuts="Escape"');
    expect(markup).toContain("Enter 发送补充，不会打断当前回复");
  });

  it("keeps the old stop-only behavior when steering is not offered", () => {
    const markup = render({ draft: "改成英文" });
    expect(markup).toContain(`aria-label="${COMPOSER_STEER_LABELS.stop}"`);
    expect(markup).toContain('title="停止"');
    expect(markup).not.toContain(COMPOSER_STEER_LABELS.steer);
    const idle = render({ responding: false, draft: "新问题", messages: [user, reply({ status: "ready", content: "好的" })] });
    expect(idle).toContain('aria-label="发送消息"');
    expect(idle).toContain('data-state="send"');
    expect(idle).not.toContain('data-state="stop"');
  });

  it("shows pending supplements after the running reply with a 补充 tag, status and withdraw button", () => {
    const markup = render({ onSteer: () => true, onCancelSupplement: noop, pendingSupplements: [
      { id: "s1", text: "改成三页", status: "queued", cancellable: true },
      { id: "s2", text: "加总结", status: "handed", cancellable: true },
      { id: "s3", text: "发送中的补充", status: "sending", cancellable: false },
    ] });
    const replyAt = markup.indexOf('data-ai-message-id="assistant-1"');
    const bubbleAt = markup.indexOf('data-steer-id="s1"');
    expect(replyAt).toBeGreaterThan(-1);
    expect(bubbleAt).toBeGreaterThan(replyAt);
    expect(markup.match(/class="tp-ai-steer__tag">补充</g)).toHaveLength(3);
    expect(markup).toContain("等当前回复结束后自动发送");
    expect(markup).toContain("已交给 AI");
    expect(markup).toContain("正在发送…");
    expect(markup.match(/aria-label="撤回这条补充"/g)).toHaveLength(2);
    // Supplements are not conversation messages yet.
    expect(markup.match(/data-ai-message-id=/g)).toHaveLength(2);
  });
});

describe("steer styles and wiring", () => {
  it("rotates the ring only when motion is allowed", () => {
    const css = readFileSync(new URL("./steer.css", import.meta.url), "utf8");
    expect(css).toContain("animation: tp-ai-send-spin 0.9s linear infinite;");
    // Shown and turning only while stopping is possible or the send is busy.
    expect(css).toContain("animation-play-state: paused;");
    expect(css).toMatch(/:is\(\[data-state="stop"\], \[data-state="busy"\]\) \.tp-ai-send-button__ring \{\s*animation-play-state: running;/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".tp-ai-send-button__ring");
    expect(reduced).toContain("animation: none;");
  });

  it("routes Enter/submit while running to the supplement handler and keeps Esc off while text is typed", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    const submit = workspace.slice(workspace.indexOf("function submitMessage("), workspace.indexOf("const { mentionedTools, requestedTool } = resolveToolIntent(draft);"));
    expect(submit).toContain('if (sendMode === "steer" && onSteer?.(draft.trim())) { onDraftChange("");');
    expect(workspace).toContain("composerHasText: Boolean(draftRef.current.trim()),");
    expect(workspace).toContain("const steerAvailable = Boolean(onSteer) && !computerRequest && !videoOpen && !videoBusy;");
  });

  it("is wired into both live workspaces", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("pendingSupplements={steer.bubbles(activeConversation?.id)}");
    expect(page).toContain("onSteer={steerAllowed && activeConversation ? text => addSupplement(activeConversation.id, text) : undefined}");
    expect(page).toContain("...(continuation?.supplement ? { supplement: true as const } : {}),");
    expect(page).toContain('continuation?.supplement ? "text" : composerTool');
    const v2 = readFileSync(new URL("./TongpinAIWorkspaceV2.tsx", import.meta.url), "utf8");
    expect(v2).toContain("pendingSupplements={steer.bubbles(activeId)}");
    expect(v2).toContain("...(supplement ? { supplement: true as const } : {})");
    // Typing is never blocked by a running reply.
    const changeDraft = v2.slice(v2.indexOf("const changeDraft = useCallback("), v2.indexOf("putCache(activeId, old => ({ ...old!, draft: value }));"));
    expect(changeDraft).not.toContain("busyRef");
  });
});
