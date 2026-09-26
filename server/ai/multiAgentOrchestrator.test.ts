import { describe, expect, it } from "vitest";
import { readAiSubagentUpdate } from "../../shared/aiMultiAgent";
import {
  combineAbortSignals, MultiAgentSources, parseMultiAgentPlan, runIsolatedSubagent, runWithConcurrencyLimit, subagentSummary,
} from "./multiAgentOrchestrator";
import { fitJsonString, utf8Bytes } from "./multiAgentPrompts";

const plan = (subtasks: unknown[]) => JSON.stringify({ subtasks });
const task = (index: number, extra: Record<string, unknown> = {}) => ({ role: "研究员", title: `子任务${index}`, task: `完成第 ${index} 个独立子任务`, search: false, ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("multi-agent plan parsing", () => {
  it("accepts the documented plan and assigns stable agent ids, roles and bounded text", () => {
    const parsed = parseMultiAgentPlan(plan([task(1), task(2, { role: "核对员", search: true })]), { searchAllowed: true });
    expect(parsed).toEqual({ kind: "plan", dropped: 0, repaired: false, subtasks: [
      { id: "agent-1", role: "研究员", title: "子任务1", task: "完成第 1 个独立子任务", search: false },
      { id: "agent-2", role: "核对员", title: "子任务2", task: "完成第 2 个独立子任务", search: true },
    ] });
    // Every parsed subtask is a valid streamed plan item.
    expect(readAiSubagentUpdate({ phase: "plan", maxConcurrency: 3, subtasks: parsed.kind === "plan" ? parsed.subtasks : [] })).toBeDefined();
  });

  it.each([
    ["fenced", `\`\`\`json\n${plan([task(1), task(2)])}\n\`\`\``],
    ["prose around it", `好的，我来拆分：\n${plan([task(1), task(2)])}\n以上。`],
    ["trailing commas", `{"subtasks":[${JSON.stringify(task(1))},${JSON.stringify(task(2))},],}`],
    ["curly quotes", plan([task(1), task(2)]).replace(/"/g, (_quote, offset: number) => offset % 2 ? "“" : "”")],
  ])("is robust to bad JSON: %s", (_label, content) => {
    const parsed = parseMultiAgentPlan(content, { searchAllowed: false });
    expect(parsed.kind).toBe("plan");
    if (parsed.kind === "plan") expect(parsed.subtasks.map(item => item.id)).toEqual(["agent-1", "agent-2"]);
  });

  it("keeps the complete subtasks of a plan cut off by the output limit", () => {
    const truncated = `{"subtasks":[${JSON.stringify(task(1))},${JSON.stringify(task(2))},{"role":"分析员","title":"第三`;
    const parsed = parseMultiAgentPlan(truncated, { searchAllowed: false });
    expect(parsed).toMatchObject({ kind: "plan", repaired: true, subtasks: [{ id: "agent-1" }, { id: "agent-2" }] });
  });

  it("caps subtasks and search agents, drops duplicates and falls back on missing role/title", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ task: `任务 ${index}`, search: true, role: index === 0 ? "一个非常非常长的角色名称" : undefined }));
    const parsed = parseMultiAgentPlan(plan([...items, { task: "任务 0" }]), { searchAllowed: true });
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.subtasks).toHaveLength(5);
    expect(parsed.dropped).toBe(3);
    expect(parsed.subtasks.filter(item => item.search)).toHaveLength(3);
    expect(parsed.subtasks[0]).toMatchObject({ role: "研究员", title: "任务 0" });
    expect(parseMultiAgentPlan(plan([task(1, { search: true })]), { searchAllowed: false })).toMatchObject({ subtasks: [{ search: false }] });
  });

  it("separates prose, tool envelopes and broken plans", () => {
    expect(parseMultiAgentPlan("这是一段直接回答，不需要拆分。", { searchAllowed: true })).toEqual({ kind: "none" });
    expect(parseMultiAgentPlan('{"kind":"image","prompt":"一只猫"}', { searchAllowed: true })).toEqual({ kind: "none" });
    expect(parseMultiAgentPlan('<tool_request>{"kind":"image","prompt":"一只猫"}</tool_request>', { searchAllowed: true })).toEqual({ kind: "none" });
    expect(parseMultiAgentPlan('{"subtasks": "oops"}', { searchAllowed: true })).toEqual({ kind: "invalid", reason: "shape" });
    expect(parseMultiAgentPlan('{"subtasks":[{"title":"没有任务"}]}', { searchAllowed: true })).toEqual({ kind: "invalid", reason: "shape" });
    expect(parseMultiAgentPlan('{"subtasks": [ {"task": "未闭合', { searchAllowed: true })).toEqual({ kind: "invalid", reason: "json" });
    expect(parseMultiAgentPlan("   ", { searchAllowed: true })).toEqual({ kind: "invalid", reason: "empty" });
  });
});

describe("bounded concurrency and isolation (adapted pool/executor)", () => {
  it("never runs more than maxConcurrency tasks and keeps item order", async () => {
    let active = 0, peak = 0;
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    const running = runWithConcurrencyLimit([0, 1, 2, 3, 4], 2, async index => {
      started.push(index); active += 1; peak = Math.max(peak, active);
      await gates[index].promise;
      active -= 1;
      return `done-${index}`;
    }, { skipped: index => `skipped-${index}`, failed: index => `failed-${index}` });
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1].resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    expect(await running).toEqual(["done-0", "done-1", "done-2", "done-3", "done-4"]);
    expect(peak).toBe(2);
  });

  it("isolates a failing task and reports never-started tasks after cancellation", async () => {
    const controller = new AbortController();
    const results = await runWithConcurrencyLimit([0, 1, 2, 3], 2, async index => {
      if (index === 0) throw new Error("boom");
      if (index === 1) controller.abort();
      return `done-${index}`;
    }, { signal: controller.signal, skipped: index => `skipped-${index}`, failed: index => `failed-${index}` });
    expect(results).toEqual(["failed-0", "done-1", "skipped-2", "skipped-3"]);
  });

  it("turns child errors, timeouts and parent cancellation into results, never throws", async () => {
    const parent = new AbortController();
    const failed = await runIsolatedSubagent({ parentSignal: parent.signal, timeoutMs: 1000, run: async () => { throw new Error("provider down"); } });
    expect(failed).toMatchObject({ ok: false, reason: "failed" });
    const hang = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const timedOut = await runIsolatedSubagent({ parentSignal: parent.signal, timeoutMs: 20, run: hang });
    expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });
    const cancelled = runIsolatedSubagent({ parentSignal: parent.signal, timeoutMs: 5000, run: hang });
    parent.abort();
    expect(await cancelled).toMatchObject({ ok: false, reason: "cancelled" });
    // A value returned after the signal aborted is not a result either.
    const late = new AbortController();
    const partial = await runIsolatedSubagent({ parentSignal: late.signal, timeoutMs: 1000, run: async () => { late.abort(); return "partial"; } });
    expect(partial).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await runIsolatedSubagent({ parentSignal: new AbortController().signal, timeoutMs: 1000, run: async () => "ok" })).toMatchObject({ ok: true, value: "ok" });
  });

  it("combines abort signals with and without AbortSignal.any", () => {
    const first = new AbortController(), second = new AbortController();
    const combined = combineAbortSignals(first.signal, undefined, second.signal);
    second.abort("second");
    expect(combined.signal?.aborted).toBe(true);
    expect(combineAbortSignals().signal).toBeUndefined();
    const any = (AbortSignal as unknown as { any?: unknown }).any;
    try {
      (AbortSignal as unknown as { any?: unknown }).any = undefined;
      const a = new AbortController(), b = new AbortController();
      const manual = combineAbortSignals(a.signal, b.signal);
      a.abort("a");
      expect(manual.signal?.aborted).toBe(true);
      expect(manual.signal?.reason).toBe("a");
      manual.cleanup();
    } finally { (AbortSignal as unknown as { any?: unknown }).any = any; }
  });
});

describe("results and sources", () => {
  it("extracts the sub-agent's own one-line summary", () => {
    expect(subagentSummary("摘要：深圳明天有雨，气温 22–27°C。\n\n- 依据一")).toBe("深圳明天有雨，气温 22–27°C。");
    expect(subagentSummary("## **结论**：可以上线\n细节")).toBe("可以上线");
    expect(subagentSummary("第一行就是结论\n第二行")).toBe("第一行就是结论");
    expect(subagentSummary("   ")).toBeUndefined();
  });

  it("numbers merged sources exactly like the reply's deduplicated source list", () => {
    const sources = new MultiAgentSources();
    expect(sources.add([{ title: "A", url: "https://a.example/x" }, { title: "B", url: "https://b.example/y" }])).toEqual([1, 2]);
    expect(sources.add([{ title: "B again", url: "https://www.b.example/y/?utm_source=x" }, { title: "C", url: "https://c.example/" }])).toEqual([2, 3]);
    expect(sources.list.map(item => item.url)).toEqual(["https://a.example/x", "https://b.example/y", "https://c.example/"]);
  });

  it("bounds a result's JSON encoding in bytes", () => {
    const fitted = fitJsonString("中文\"引号\"\n".repeat(200), 300);
    expect(fitted.truncated).toBe(true);
    expect(utf8Bytes(JSON.stringify(fitted.text))).toBeLessThanOrEqual(300);
    expect(fitJsonString("short", 300)).toEqual({ text: "short", truncated: false });
  });
});
