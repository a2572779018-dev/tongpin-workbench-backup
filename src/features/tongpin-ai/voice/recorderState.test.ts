import { describe, expect, it } from "vitest";
import {
  audioLevel, formatRecordingTime, INITIAL_RECORDER_STATE, joinTranscript, levelBars, pickRecorderMimeType, recorderBusy,
  recorderReducer, recordingFileName, recordingStopReason, trackSilence, type RecorderEvent, type RecorderState,
} from "./recorderState";

const run = (events: RecorderEvent[], state: RecorderState = INITIAL_RECORDER_STATE) => events.reduce(recorderReducer, state);
const issue = { message: "麦克风被拒绝", canOpenSettings: true };

describe("recorder state", () => {
  it("walks start → recording → transcribing → idle with elapsed time and recent levels", () => {
    const recording = run([{ type: "start" }, { type: "started", at: 1_000 }, { type: "tick", now: 1_100, level: 0.2 }, { type: "tick", now: 4_600, level: 2 }]);
    expect(recording).toMatchObject({ phase: "recording", startedAt: 1_000, elapsedMs: 3_600, levels: [0.2, 1] });
    expect(recorderBusy(recording)).toBe(true);
    const levels = run(Array.from({ length: 8 }, (_, index) => ({ type: "tick", now: 2_000 + index, level: index / 10 }) as RecorderEvent), recording);
    expect(levels.levels).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
    const transcribing = recorderReducer(recording, { type: "stop", notice: "已到单次录音上限，已自动停止" });
    expect(transcribing).toMatchObject({ phase: "transcribing", levels: [], notice: "已到单次录音上限，已自动停止" });
    expect(recorderReducer(transcribing, { type: "transcribed" })).toEqual(INITIAL_RECORDER_STATE);
    expect(recorderReducer(transcribing, { type: "transcribed", notice: "没有识别到说话内容" })).toMatchObject({ phase: "idle", notice: "没有识别到说话内容" });
  });

  it("ignores events that do not belong to the current phase", () => {
    expect(recorderReducer(INITIAL_RECORDER_STATE, { type: "stop" })).toBe(INITIAL_RECORDER_STATE);
    expect(recorderReducer(INITIAL_RECORDER_STATE, { type: "tick", now: 5, level: 1 })).toBe(INITIAL_RECORDER_STATE);
    const transcribing = run([{ type: "start" }, { type: "started", at: 0 }, { type: "stop" }]);
    expect(recorderReducer(transcribing, { type: "start" })).toBe(transcribing);
    expect(recorderReducer(transcribing, { type: "cancel" })).toBe(transcribing);
    expect(recorderReducer(run([{ type: "start" }]), { type: "started", at: 1 }).phase).toBe("recording");
    expect(recorderReducer(INITIAL_RECORDER_STATE, { type: "started", at: 1 })).toBe(INITIAL_RECORDER_STATE);
  });

  it("keeps an error until dismissed and allows a new attempt from it", () => {
    const failed = run([{ type: "start" }, { type: "fail", issue }]);
    expect(failed).toMatchObject({ phase: "error", issue });
    expect(recorderBusy(failed)).toBe(false);
    expect(recorderReducer(failed, { type: "dismiss" })).toEqual(INITIAL_RECORDER_STATE);
    expect(recorderReducer(failed, { type: "start" })).toMatchObject({ phase: "starting", issue: null });
    expect(run([{ type: "start" }, { type: "started", at: 0 }, { type: "cancel", notice: "没有听到说话声" }])).toMatchObject({ phase: "idle", notice: "没有听到说话声" });
  });

  it("stops at the cap, after silence following speech, or when nobody speaks", () => {
    const quiet = { speechAt: null, lastLoudAt: null };
    expect(recordingStopReason(0, quiet, 59_999, { maxMs: 60_000 })).toBeNull();
    expect(recordingStopReason(0, quiet, 60_000, { maxMs: 60_000 })).toBe("limit");
    expect(recordingStopReason(0, quiet, 30_000, { maxMs: 60_000 })).toBeNull();
    let tracker = trackSilence(quiet, 1_000, 0.01);
    expect(tracker).toBe(quiet);
    tracker = trackSilence(tracker, 1_500, 0.5);
    tracker = trackSilence(tracker, 2_000, 0.3);
    expect(tracker).toEqual({ speechAt: 1_500, lastLoudAt: 2_000 });
    const options = { maxMs: 60_000, silenceStopMs: 1_800, noSpeechMs: 8_000 };
    expect(recordingStopReason(0, tracker, 3_700, options)).toBeNull();
    expect(recordingStopReason(0, tracker, 3_800, options)).toBe("silence");
    expect(recordingStopReason(0, quiet, 7_999, options)).toBeNull();
    expect(recordingStopReason(0, quiet, 8_000, options)).toBe("no-speech");
  });
});

describe("recorder helpers", () => {
  it("computes a display level from 8-bit samples", () => {
    expect(audioLevel(new Uint8Array(64).fill(128))).toBe(0);
    expect(audioLevel(new Uint8Array([128, 160, 128, 96]))).toBeCloseTo(0.707, 2);
    expect(audioLevel(new Uint8Array([0, 255]))).toBe(1);
    expect(audioLevel(new Uint8Array())).toBe(0);
    expect(levelBars([0.5])).toEqual([0.18, 0.18, 0.18, 0.18, 0.59]);
    expect(levelBars([2, -1, 0.25, 0.5, 0.75, 1])).toEqual([0.18, 0.385, 0.59, 0.795, 1]);
  });

  it("picks the first supported recorder type and names the upload", () => {
    expect(pickRecorderMimeType(type => type === "audio/webm")).toBe("audio/webm");
    expect(pickRecorderMimeType(type => type.startsWith("audio/webm;codecs=opus"))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType(() => { throw new Error("unsupported"); })).toBe("");
    expect(recordingFileName("audio/webm;codecs=opus")).toBe("voice.webm");
    expect(recordingFileName("audio/ogg;codecs=opus")).toBe("voice.ogg");
    expect(recordingFileName("audio/mp4")).toBe("voice.m4a");
    expect(formatRecordingTime(0)).toBe("0:00");
    expect(formatRecordingTime(59_999)).toBe("0:59");
    expect(formatRecordingTime(60_000)).toBe("1:00");
  });

  it("appends a transcript to the draft like a person would type it", () => {
    expect(joinTranscript("", "  你好  ")).toBe("你好");
    expect(joinTranscript("请总结", "今天的会议")).toBe("请总结今天的会议");
    expect(joinTranscript("Summarize", "the meeting")).toBe("Summarize the meeting");
    expect(joinTranscript("Summarize", "今天的会议")).toBe("Summarize今天的会议");
    expect(joinTranscript("第一行\n", "第二行")).toBe("第一行\n第二行");
    expect(joinTranscript("草稿", "   ")).toBe("草稿");
  });
});
