import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_MOTION_DURATION_MS, AI_MOTION_OPTIONS, attachAiMotion, prefersReducedMotion } from "./motion";
import { ChatMessageRow, chatMessageRowPropsEqual } from "./ChatMessageRow";
import type { TongpinAIMessage } from "./types";

type Listener = () => void;
function stubMotionPreference(initial: boolean) {
  const listeners = new Set<Listener>();
  const media = {
    matches: initial,
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  };
  vi.stubGlobal("window", { matchMedia: (query: string) => (expect(query).toBe("(prefers-reduced-motion: reduce)"), media) });
  return { set(value: boolean) { media.matches = value; listeners.forEach(listener => listener()); }, listeners };
}
function fakeParent(childElementCount = 0) {
  return { childElementCount } as unknown as HTMLElement;
}
function spyAnimate() {
  const destroy = vi.fn();
  const animate = vi.fn(() => ({ destroy }) as never);
  return { animate, destroy };
}

afterEach(() => vi.unstubAllGlobals());

describe("同频 AI motion", () => {
  it("stays inside the 150–220ms budget", () => {
    expect(AI_MOTION_DURATION_MS).toBeGreaterThanOrEqual(150);
    expect(AI_MOTION_DURATION_MS).toBeLessThanOrEqual(220);
    expect(AI_MOTION_OPTIONS).not.toHaveProperty("disrespectUserMotionPreference");
  });

  it("does not animate at all under prefers-reduced-motion", () => {
    stubMotionPreference(true);
    const { animate } = spyAnimate();
    expect(prefersReducedMotion()).toBe(true);
    attachAiMotion(fakeParent(), { animate });
    expect(animate).not.toHaveBeenCalled();
  });

  it("follows a live reduced-motion change and cleans up its listener", () => {
    const preference = stubMotionPreference(false);
    const { animate, destroy } = spyAnimate();
    const detach = attachAiMotion(fakeParent(), { animate });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: AI_MOTION_DURATION_MS }));
    preference.set(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    preference.set(false);
    expect(animate).toHaveBeenCalledTimes(2);
    detach();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(preference.listeners.size).toBe(0);
  });

  it("leaves long lists and settled history slots static", () => {
    stubMotionPreference(false);
    const { animate } = spyAnimate();
    attachAiMotion(fakeParent(500), { animate });
    attachAiMotion(fakeParent(1), { animate, onlyIfEmpty: true });
    expect(animate).not.toHaveBeenCalled();
  });

  it("never animates the message log or per-delta text", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).not.toContain("@formkit/auto-animate");
    expect(workspace).not.toMatch(/aiMotionRef|aiLiveMotionRef/);
    const markdown = readFileSync(new URL("./MarkdownReply.tsx", import.meta.url), "utf8");
    expect(markdown).not.toMatch(/auto-animate|aiMotionRef/);
  });
});

describe("ChatMessageRow memo", () => {
  const settled: TongpinAIMessage = { id: "a", role: "assistant", content: "完成的回答", time: "12:00", status: "ready" };
  const streaming: TongpinAIMessage = { id: "b", role: "assistant", content: "正在", time: "12:01", status: "typing" };
  const onCopy = () => undefined, onOpenArtifact = () => undefined, onRetry = () => undefined, onTraceChange = () => undefined;
  const rowProps = (message: TongpinAIMessage) => ({ message, artifact: undefined, assistantName: "同频", copied: false, retryable: false,
    retryDisabled: true, onCopy, onOpenArtifact, onRetry, onTraceChange });

  it("uses the shallow comparator", () => {
    expect((ChatMessageRow as unknown as { compare: unknown }).compare).toBe(chatMessageRowPropsEqual);
  });

  it("skips settled rows when an unrelated streamed delta arrives", () => {
    // Mirrors TongpinAIPage: only the in-flight message is re-spread per delta.
    const stream: Record<string, Partial<TongpinAIMessage>> = { b: { content: "正在输入更多" } };
    const before = [settled, streaming];
    const after = before.map(message => stream[message.id] ? { ...message, ...stream[message.id] } : message);
    expect(chatMessageRowPropsEqual(rowProps(before[0]), rowProps(after[0]))).toBe(true);
    expect(chatMessageRowPropsEqual(rowProps(before[1]), rowProps(after[1]))).toBe(false);
  });

  it("re-renders when a row's own state changes", () => {
    expect(chatMessageRowPropsEqual(rowProps(settled), { ...rowProps(settled), copied: true })).toBe(false);
    expect(chatMessageRowPropsEqual(rowProps(settled), { ...rowProps(settled), onTraceChange: () => undefined })).toBe(false);
  });

  it("hands every row ref-stable callbacks instead of per-render closures", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("onTraceChange={onTraceChange ? traceChange : undefined}");
    expect(workspace).toContain("onMediaTask={artifact?.data?.mediaTaskRequestId && onMediaTask ? mediaTask : undefined}");
    expect(workspace).not.toContain("onMediaTask={artifact?.data?.mediaTaskRequestId && onMediaTask ? task =>");
    expect(workspace).toContain("followFrameRef.current = requestAnimationFrame(");
  });
});

describe("opening the AI page", () => {
  it("reads as opening, not as a lock, while it loads", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AiAccessState } = await import("./AiAccessState");
    const loading = renderToStaticMarkup(createElement(AiAccessState, { name: "小秋", loading: true, onRetry: () => undefined }));
    expect(loading).toContain('class="tp-ai-entry is-loading"');
    expect(loading).toContain("正在打开同频 AI");
    expect(loading).toContain("tp-ai-entry__spinner");
    expect(loading).not.toContain("<button");
    const locked = renderToStaticMarkup(createElement(AiAccessState, { name: "小秋", loading: false, locked: true, onRetry: () => undefined }));
    expect(locked).toContain('class="tp-ai-entry"');
    expect(locked).toContain("你的 AI 还未开通");
    expect(locked).not.toContain("tp-ai-entry__spinner");
  });

  it("delays the loading card, eases the workspace in with opacity only, and stays still under reduced motion", () => {
    const css = readFileSync(new URL("./ai-refinements.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tp-ai-entry\.is-loading \.tp-ai-entry__card,\n\.tp-ai-entry\.is-loading \.tp-ai-entry__account \{ animation: tp-ai-entry-wait 220ms ease 320ms backwards; \}/);
    expect(css).toContain(".tp-ai-page { animation: tp-ai-page-in 240ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards; }");
    expect(css).toContain("@keyframes tp-ai-page-in { from { opacity: 0; } }");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.tp-ai-entry\.is-loading \.tp-ai-entry__card,\n  \.tp-ai-entry\.is-loading \.tp-ai-entry__account,\n  \.tp-ai-entry__spinner,\n  \.tp-ai-page \{ animation: none; \}\n\}/);
  });
});
