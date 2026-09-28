import { describe, expect, it, vi } from "vitest";
import { VoiceCallController, type CallHost, type CallReplyLike, type CallSpeakerLike } from "./voiceCallController";

function harness(overrides: Partial<CallHost> = {}) {
  const spoken: string[] = [];
  const events: string[] = [];
  const speaker: CallSpeakerLike = {
    start: id => { events.push(`start:${id}`); },
    push: (_id, content) => { spoken.push(content); },
    finish: id => { events.push(`finish:${id}`); },
    stopAll: () => { events.push("stopAll"); },
  };
  const host: CallHost = {
    transcribe: vi.fn(async () => "明天要带伞吗"),
    submitTurn: vi.fn(() => ({ ok: true as const })),
    stopReply: vi.fn(),
    errorMessage: () => "识别失败",
    ...overrides,
  };
  const microphone = { resume: vi.fn(), pause: vi.fn(), destroy: vi.fn() };
  // Busy retries pass at once; the no-reply watchdog fires only when a test releases it.
  const watchdogs: Array<() => void> = [];
  const wait = (ms: number) => ms >= 8000 ? new Promise<void>(resolve => { watchdogs.push(resolve); }) : Promise.resolve();
  const call = new VoiceCallController(host, speaker, wait);
  call.open();
  call.attach(microphone);
  return { call, host, speaker, microphone, spoken, events, watchdogs };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const history: CallReplyLike[] = [{ id: "u0", role: "user", content: "你好" }, { id: "a0", role: "assistant", content: "你好！", status: "ready" }];

describe("语音通话 controller (Open WebUI call-mode flow)", () => {
  it("listens, sends the transcript, mutes while the reply is spoken, then listens again", async () => {
    const { call, host, microphone, spoken, events } = harness();
    call.updateMessages(history);
    expect(call.getState().phase).toBe("listening");
    call.speechStarted();
    expect(call.getState().phase).toBe("hearing");
    call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    expect(host.submitTurn).toHaveBeenCalledWith("明天要带伞吗");
    expect(call.getState()).toMatchObject({ phase: "thinking", heard: "明天要带伞吗" });
    expect(microphone.pause).toHaveBeenCalled();
    // The new reply streams in; only finished sentences are queued.
    call.updateMessages([...history, { id: "u1", role: "user", content: "明天要带伞吗" }, { id: "a1", role: "assistant", content: "明天上午有雨。下午", status: "thinking" }]);
    expect(events).toContain("start:a1");
    expect(spoken).toEqual(["明天上午有雨。"]);
    call.speaking("明天上午有雨。");
    expect(call.getState().phase).toBe("speaking");
    call.updateMessages([...history, { id: "u1", role: "user", content: "明天要带伞吗" }, { id: "a1", role: "assistant", content: "明天上午有雨。下午转晴，记得带伞。", status: "ready" }]);
    expect(spoken).toEqual(["明天上午有雨。", "下午转晴，记得带伞。"]);
    expect(events).toContain("finish:a1");
    const resumes = microphone.resume.mock.calls.length;
    call.drained();
    expect(call.getState().phase).toBe("listening");
    expect(microphone.resume.mock.calls.length).toBe(resumes + 1);
  });

  it("carries words heard before a pause into the next utterance instead of sending half a thought", async () => {
    let answer = "帮我查一下";
    const { call, host } = harness({ transcribe: vi.fn(async () => answer) });
    call.speechStarted();
    call.speechEnded(new Float32Array(16000));
    call.speechStarted(); // talking again while the first part is transcribed
    await flush(); await flush();
    expect(host.submitTurn).not.toHaveBeenCalled();
    answer = "明天的天气";
    call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    expect(host.submitTurn).toHaveBeenCalledWith("帮我查一下明天的天气");
  });

  it("interrupt stops a reply that is still running and listens again", async () => {
    const { call, host, events } = harness();
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    call.updateMessages([{ id: "a1", role: "assistant", content: "第一句。第二", status: "thinking" }]);
    call.interrupt();
    expect(events).toContain("stopAll");
    expect(host.stopReply).toHaveBeenCalled();
    expect(call.getState().phase).toBe("listening");
  });

  it("waits for a busy conversation, then reports a failed send and keeps listening", async () => {
    const submitTurn = vi.fn()
      .mockReturnValueOnce({ ok: false, reason: "busy" })
      .mockReturnValueOnce({ ok: true });
    const { call } = harness({ submitTurn });
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush(); await flush();
    expect(submitTurn).toHaveBeenCalledTimes(2);
    expect(call.getState().phase).toBe("thinking");

    const refused = harness({ submitTurn: vi.fn(() => ({ ok: false as const, reason: "AI 额度不足，请联系管理员增加额度。" })) });
    refused.call.speechStarted(); refused.call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    expect(refused.call.getState()).toMatchObject({ phase: "listening", notice: "AI 额度不足，请联系管理员增加额度。" });
  });

  it("apologizes aloud when the reply fails before saying anything", async () => {
    const { call, spoken } = harness();
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    call.updateMessages([{ id: "a1", role: "assistant", content: "服务暂时不可用", status: "error" }]);
    expect(spoken).toEqual(["抱歉，这次没有回答成功，请再说一遍。"]);
    expect(call.getState().notice).toBe("服务暂时不可用");
  });

  it("says a short cue when a spoken request became a task card waiting for a click", async () => {
    const { call, spoken } = harness();
    call.updateMessages(history);
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    call.updateMessages([...history, { id: "a1", role: "assistant", content: "", status: "thinking" }]);
    call.updateMessages([...history, { id: "a1", role: "assistant", content: "", status: "ready", artifactId: "artifact-1" }]);
    expect(spoken).toEqual(["好的，任务已经放到对话里了，需要确认的话请在屏幕上点一下。"]);
  });

  it("reads out a reply that arrives on its own while listening (an operation's result), never old history", () => {
    const { call, spoken, microphone } = harness();
    call.updateMessages(history);
    expect(spoken).toEqual([]);
    call.updateMessages([...history, { id: "c1", role: "assistant", content: "已完成：计算器显示的结果是 4608。", status: "ready" }]);
    expect(spoken).toEqual(["已完成：计算器显示的结果是 4608。"]);
    expect(microphone.pause).toHaveBeenCalled();
    call.speaking("已完成：计算器显示的结果是 4608。");
    call.drained();
    call.updateMessages([...history, { id: "c1", role: "assistant", content: "已完成：计算器显示的结果是 4608。", status: "ready" }]);
    expect(spoken).toHaveLength(1);
  });

  it("gives the microphone back when a sent turn never produces a reply, or the composer refuses it", async () => {
    const { call, watchdogs } = harness();
    call.updateMessages(history);
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    expect(call.getState().phase).toBe("thinking");
    watchdogs.forEach(release => release());
    await flush();
    expect(call.getState()).toMatchObject({ phase: "listening", notice: "这句话没有发出去，请再说一遍。" });

    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    call.notSent("图片生成尚未启用，请联系管理员配置。");
    expect(call.getState()).toMatchObject({ phase: "listening", notice: "图片生成尚未启用，请联系管理员配置。" });
  });

  it("says when a spoken request's image finishes, but not for cards that were already there", () => {
    const { call, spoken, events } = harness();
    const card = (status: string): CallReplyLike => ({ id: "m1", role: "assistant", content: "", status: "ready", artifactId: "artifact-1", task: { kind: "图片", status } });
    call.updateMessages([...history, card("completed")]);
    expect(spoken).toEqual([]);
    const fresh = harness();
    fresh.call.updateMessages(history);
    fresh.call.updateMessages([...history, card("running")]);
    fresh.call.updateMessages([...history, card("completed")]);
    expect(fresh.spoken).toEqual(["图片已经生成好了，在对话里可以看到。"]);
    expect(events).toEqual([]);
  });

  it("an empty transcript asks to repeat without sending", async () => {
    const { call, host } = harness({ transcribe: vi.fn(async () => "") });
    call.speechStarted(); call.speechEnded(new Float32Array(16000));
    await flush(); await flush();
    expect(host.submitTurn).not.toHaveBeenCalled();
    expect(call.getState()).toMatchObject({ phase: "listening", notice: "没听清，请再说一遍。" });
  });

  it("hang up silences the call and releases the microphone", () => {
    const { call, microphone, events } = harness();
    call.hangUp();
    expect(events).toContain("stopAll");
    expect(microphone.destroy).toHaveBeenCalled();
    call.speechStarted();
    expect(call.getState().phase).toBe("listening");
  });
});
