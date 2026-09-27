import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_LIVE_ROWS, planMessageMotion, playMessageMotion, type MotionMessage } from "./messageMotion";

const user = (id: string, content = "你好"): MotionMessage => ({ id, role: "user", content });
const reply = (id: string, status = "ready", content = "回答"): MotionMessage => ({ id, role: "assistant", status, content });
const baseline = (conversationId: string | undefined, messages: MotionMessage[]) => ({ conversationId, ids: messages.map(message => message.id) });

describe("chat entrance motion plan", () => {
  it("stays still on mount and while a reply streams into its row", () => {
    const history = [user("u1"), reply("a1")];
    expect(planMessageMotion(null, "c1", history)).toEqual({ list: false, rows: [] });
    const streaming = [...history, user("u2"), reply("a2", "thinking", "正在")];
    expect(planMessageMotion(baseline("c1", streaming), "c1", streaming.map(message => ({ ...message })))).toEqual({ list: false, rows: [] });
  });

  it("eases in the sent message and the reply placeholder", () => {
    const history = [user("u1"), reply("a1")];
    const sent = [...history, user("u2"), reply("a2", "thinking", "")];
    expect(planMessageMotion(baseline("c1", history), "c1", sent)).toEqual({ list: false, rows: [{ id: "u2", entrance: "user" }, { id: "a2", entrance: "assistant" }] });
  });

  it("eases in a result appended on its own (e.g. a computer-use report)", () => {
    const history = [user("u1"), reply("a1")];
    expect(planMessageMotion(baseline("c1", history), "c1", [...history, reply("r1")]).rows).toEqual([{ id: "r1", entrance: "assistant" }]);
  });

  it("leaves history loaded above, bulk hydration and replaced rows still", () => {
    const recent = [user("u3"), reply("a3")];
    expect(planMessageMotion(baseline("c1", recent), "c1", [user("u1"), reply("a1"), ...recent]).rows).toEqual([]);
    const bulk = Array.from({ length: MAX_LIVE_ROWS + 1 }, (_, index) => index % 2 ? reply(`a${index}`) : user(`u${index}`));
    expect(planMessageMotion(baseline("c1", []), "c1", bulk).rows).toEqual([]);
    // A streamed placeholder swapped for the saved reply is the same content.
    const streamed = [user("u1"), reply("stream-c1", "thinking", "完整回答")];
    expect(planMessageMotion(baseline("c1", streamed), "c1", [user("u1"), reply("a1", "ready", "完整回答")]).rows).toEqual([]);
  });

  it("fades the log when another conversation opens, but animates the rows of a first send", () => {
    expect(planMessageMotion(baseline("c1", [user("u1")]), "c2", [user("x1"), reply("x2")])).toEqual({ list: true, rows: [] });
    expect(planMessageMotion(baseline("c1", [user("u1")]), undefined, [])).toEqual({ list: true, rows: [] });
    // From the welcome screen: the new conversation holds just this send.
    expect(planMessageMotion(baseline(undefined, []), "c3", [user("n1"), reply("n2", "thinking", "")]))
      .toEqual({ list: false, rows: [{ id: "n1", entrance: "user" }, { id: "n2", entrance: "assistant" }] });
    // From the welcome screen into an existing, settled conversation: a switch.
    expect(planMessageMotion(baseline(undefined, []), "c1", [user("u1"), reply("a1")])).toEqual({ list: true, rows: [] });
  });
});

describe("chat entrance motion playback", () => {
  function fakeList(ids: string[]) {
    const rows = ids.map(id => ({ dataset: { aiMessageId: id }, animate: vi.fn() }));
    return { list: { animate: vi.fn(), querySelectorAll: () => rows } as unknown as HTMLElement & { animate: ReturnType<typeof vi.fn> }, rows };
  }

  it("animates the planned rows and the log with the Web Animations API", () => {
    const { list, rows } = fakeList(["u1", "a1", "u2", "a2"]);
    playMessageMotion(list, { list: false, rows: [{ id: "u2", entrance: "user" }, { id: "a2", entrance: "assistant" }] }, () => false);
    expect(rows[0].animate).not.toHaveBeenCalled();
    expect(rows[2].animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: 240 }));
    expect(rows[3].animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ delay: 90, fill: "backwards" }));
    playMessageMotion(list, { list: true, rows: [] }, () => false);
    expect(list.animate).toHaveBeenCalledTimes(1);
  });

  it("does nothing under prefers-reduced-motion", () => {
    const { list, rows } = fakeList(["u1"]);
    playMessageMotion(list, { list: true, rows: [{ id: "u1", entrance: "user" }] }, () => true);
    expect(list.animate).not.toHaveBeenCalled();
    expect(rows[0].animate).not.toHaveBeenCalled();
  });

  it("is wired into the workspace before paint, keyed on the conversation and its messages", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).toMatch(/useLayoutEffect\(\(\) => \{\n\s+const plan = planMessageMotion\(motionBaselineRef\.current, conversationId, messages\);/);
    expect(workspace).toContain("}, [conversationId, messages]);");
  });
});
