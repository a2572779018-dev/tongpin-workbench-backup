import { describe, expect, it, vi } from "vitest";
import { SpeechPlayer, type AudioLike, type SpeechEnvironment, type SynthesisLike, type UtteranceLike } from "./speechPlayer";

function fakeEnvironment(voices = [{ name: "Tingting", lang: "zh-CN", localService: true }, { name: "Samantha", lang: "en-US", localService: true }]) {
  const spoken: UtteranceLike[] = [];
  const audios: Array<AudioLike & { url: string; ended(): void; failed(): void; paused: boolean }> = [];
  const revoked: string[] = [];
  let current: UtteranceLike | null = null;
  const synthesis: SynthesisLike & { finish(): void } = {
    speak: utterance => { spoken.push(utterance); current = utterance; },
    cancel: vi.fn(() => { const active = current; current = null; active?.onerror?.({ error: "canceled" }); }),
    getVoices: () => voices,
    finish: () => { const active = current; current = null; active?.onend?.(); },
  };
  let urlCounter = 0;
  const environment: SpeechEnvironment = {
    synthesis,
    createUtterance: text => ({ text, lang: "", rate: 1, voice: null, onend: null, onerror: null }),
    createAudio: url => {
      const audio = {
        url, playbackRate: 1, paused: false, onended: null as (() => void) | null, onerror: null as (() => void) | null,
        play: vi.fn(async () => undefined), pause() { this.paused = true; },
        ended() { this.onended?.(); }, failed() { this.onerror?.(); },
      };
      audios.push(audio);
      return audio;
    },
    createObjectUrl: () => `blob:voice-${++urlCounter}`,
    revokeObjectUrl: url => { revoked.push(url); },
  };
  return { environment, synthesis, spoken, audios, revoked };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("speech player", () => {
  it("reads cleaned text chunk by chunk with a Chinese system voice and the member's rate", async () => {
    const fake = fakeEnvironment();
    const player = new SpeechPlayer(() => fake.environment);
    const listener = vi.fn();
    player.subscribe(listener);
    const done = player.play("m1", `## 标题\n${"这是一句需要朗读的话。".repeat(30)}\n\`\`\`js\nconsole.log(1)\n\`\`\``, { engine: "browser", rate: 1.25 });
    await settle();
    expect(player.snapshot("m1")).toBe("speaking\u0000");
    expect(player.snapshot("m2")).toBe("idle\u0000");
    expect(fake.spoken[0]).toMatchObject({ lang: "zh-CN", rate: 1.25, voice: { name: "Tingting" } });
    expect(fake.spoken[0].text.startsWith("标题")).toBe(true);
    while (player.getState().status !== "idle") { fake.synthesis.finish(); await settle(); }
    expect(await done).toEqual({ outcome: "completed" });
    expect(fake.spoken.length).toBeGreaterThan(1);
    expect(fake.spoken.at(-1)!.text).toContain("此处省略代码。");
    expect(fake.spoken.map(item => item.text).join("")).not.toContain("console");
    expect(listener).toHaveBeenCalled();
  });

  it("stops at once and a new reply replaces the previous one", async () => {
    const fake = fakeEnvironment();
    const player = new SpeechPlayer(() => fake.environment);
    const first = player.play("m1", "第一条回复。".repeat(40), { engine: "browser", rate: 1 });
    await settle();
    const second = player.play("m2", "第二条回复。", { engine: "browser", rate: 1 });
    expect(await first).toEqual({ outcome: "stopped" });
    await settle();
    expect(player.getState()).toMatchObject({ key: "m2", status: "speaking" });
    player.stop();
    expect(await second).toEqual({ outcome: "stopped" });
    expect(player.getState()).toEqual({ key: null, status: "idle", error: "" });
    expect(fake.synthesis.cancel).toHaveBeenCalled();
  });

  it("plays external audio chunks in order, prefetching the next one, and revokes object URLs", async () => {
    const fake = fakeEnvironment();
    const player = new SpeechPlayer(() => fake.environment);
    const requests: string[] = [];
    const synthesize = vi.fn(async (text: string, _signal: AbortSignal) => { requests.push(text); return new Blob([text], { type: "audio/mpeg" }); });
    const done = player.play("m1", `${"甲".repeat(590)}。${"乙".repeat(300)}。`, { engine: "external", rate: 1.5, synthesize });
    await settle();
    expect(requests).toHaveLength(2);
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0].playbackRate).toBe(1.5);
    expect(player.getState().status).toBe("speaking");
    fake.audios[0].ended();
    await settle();
    expect(fake.audios).toHaveLength(2);
    fake.audios[1].ended();
    expect(await done).toEqual({ outcome: "completed" });
    expect(fake.revoked).toEqual(["blob:voice-1", "blob:voice-2"]);
    expect(synthesize.mock.calls.every(([, signal]) => signal instanceof AbortSignal)).toBe(true);
  });

  it("reports failures on the message that failed and aborts pending audio on stop", async () => {
    const fake = fakeEnvironment();
    const player = new SpeechPlayer(() => fake.environment);
    const failed = await player.play("m1", "朗读失败的回复。", { engine: "external", rate: 1, synthesize: async () => { throw new Error("同频点不足以朗读这段内容"); } });
    expect(failed.outcome).toBe("failed");
    expect(player.snapshot("m1")).toBe("idle\u0000同频点不足以朗读这段内容");
    let signal: AbortSignal | undefined;
    const pending = player.play("m2", "等待中的朗读。", { engine: "external", rate: 1, synthesize: (_text, abort) => { signal = abort; return new Promise(() => undefined); } });
    await settle();
    expect(player.getState()).toMatchObject({ key: "m2", status: "loading" });
    player.stop();
    expect(signal?.aborted).toBe(true);
    expect(await Promise.race([pending, settle().then(() => "hung")])).toEqual({ outcome: "stopped" });
    expect(await player.play("m3", "```followups\n[]\n```", { engine: "browser", rate: 1 })).toMatchObject({ outcome: "failed" });
    expect(player.snapshot("m3")).toBe("idle\u0000这条回复没有可朗读的文字");
  });

  it("keeps a prepared request from starting after the member pressed stop", async () => {
    const fake = fakeEnvironment();
    const player = new SpeechPlayer(() => fake.environment);
    const ticket = player.prepare("m1");
    expect(player.snapshot("m1")).toBe("loading\u0000");
    player.stop();
    expect(await player.play("m1", "不会朗读。", { engine: "browser", rate: 1 }, ticket)).toEqual({ outcome: "stopped" });
    expect(fake.spoken).toHaveLength(0);
  });
});
