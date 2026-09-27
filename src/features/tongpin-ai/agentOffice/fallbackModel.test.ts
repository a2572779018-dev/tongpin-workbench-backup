import { describe, expect, it } from "vitest";
import { buildFallbackRows, formatElapsed, STATUS_LABELS } from "./fallbackModel";
import type { AgentOfficeSnapshot } from "./types";

describe("formatElapsed", () => {
  it("returns null before the worker has started", () => {
    expect(formatElapsed(undefined, undefined, 1000)).toBeNull();
  });
  it("formats under a minute as whole seconds", () => {
    expect(formatElapsed(1000, undefined, 1000 + 12_000)).toBe("12 秒");
  });
  it("formats a minute or more as '分 / 秒'", () => {
    expect(formatElapsed(0, undefined, 65_000)).toBe("1 分 05 秒");
  });
  it("freezes at the finish time once finishedAt is set, ignoring `now`", () => {
    expect(formatElapsed(0, 10_000, 999_999)).toBe("10 秒");
  });
});

describe("buildFallbackRows", () => {
  function snapshot(): AgentOfficeSnapshot {
    return {
      runId: "run-1",
      phase: "working",
      coordinator: { name: "Pro 协调", status: "working", activity: "跟进研究员进度" },
      workers: [
        { id: "w1", role: "研究员", title: "行业数据", task: "查找行业数据", status: "searching", activity: "联网搜索行业报告", startedAt: 0 },
        { id: "w2", role: "撰稿员", task: "撰写摘要", status: "done", startedAt: 0, finishedAt: 5000, resultSummary: "已完成摘要", sourceCount: 3 },
      ],
      updatedAt: 5000,
    };
  }

  it("always leads with the coordinator row", () => {
    const rows = buildFallbackRows(snapshot(), 5000);
    expect(rows[0].id).toBe("__coordinator__");
    expect(rows[0].label).toBe("协调员");
    expect(rows[0].title).toBeNull();
    expect(rows[0].task).toBe("跟进研究员进度");
  });

  it("carries every worker's role, task, status label, elapsed time and result", () => {
    const rows = buildFallbackRows(snapshot(), 5000);
    const w1 = rows.find((r) => r.id === "w1")!;
    expect(w1.label).toBe("研究员");
    expect(w1.title).toBe("行业数据");
    expect(w1.statusText).toBe(STATUS_LABELS.searching);
    expect(w1.elapsedText).toBe("5 秒");

    const w2 = rows.find((r) => r.id === "w2")!;
    expect(w2.statusText).toBe(STATUS_LABELS.done);
    expect(w2.title).toBeNull();
    expect(w2.elapsedText).toBe("5 秒");
    expect(w2.resultSummary).toBe("已完成摘要");
    expect(w2.sourceCount).toBe(3);
  });

  it("falls back to the run phase when the coordinator has no live activity", () => {
    const snap = snapshot();
    snap.coordinator.activity = undefined;
    snap.phase = "synthesizing";
    const rows = buildFallbackRows(snap, 5000);
    expect(rows[0].task).toBe("综合结果中");
  });
});
