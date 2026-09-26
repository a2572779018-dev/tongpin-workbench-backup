import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { releaseNoteItems } from "./releaseNotes";

const require = createRequire(import.meta.url);
const {
  normalizeReleaseNotes,
  splitReleaseNoteItems,
}: {
  normalizeReleaseNotes(value: unknown, maxLength?: number): string;
  splitReleaseNoteItems(value: unknown): string[];
} = require("../../electron/release-notes.cjs");

const MULTI_LINE_NOTES = [
  "聊天回复新增按需富内容：数值图表、数学公式渲染、追问建议；",
  "人设库新增 2 个通用方法论人设（情商沟通、社会情感学习）；",
  "修复工具请求信封跟随正文时被误当作可见正文泄漏的问题；",
  "保留任务、客户脉络图、AI 历史。本次仅部署服务端与安装 Mac，不推送 Windows。",
].join("\n");

describe("updater release notes", () => {
  it("keeps one item per line instead of collapsing the list into one paragraph", () => {
    expect(normalizeReleaseNotes(MULTI_LINE_NOTES).split("\n")).toEqual([
      "聊天回复新增按需富内容：数值图表、数学公式渲染、追问建议",
      "人设库新增 2 个通用方法论人设（情商沟通、社会情感学习）",
      "修复工具请求信封跟随正文时被误当作可见正文泄漏的问题",
      "保留任务、客户脉络图、AI 历史。本次仅部署服务端与安装 Mac，不推送 Windows。",
    ]);
  });

  it("reads the Windows CRLF scalar and the Mac block scalar identically", () => {
    const windows = MULTI_LINE_NOTES.replace(/\n/g, "\r\n") + "\r\n";
    expect(normalizeReleaseNotes(windows)).toBe(normalizeReleaseNotes(MULTI_LINE_NOTES));
  });

  it("splits legacy single-line notes on the Chinese semicolon", () => {
    expect(normalizeReleaseNotes("老板通知新增铃声；左上角显示版本号。\r\n")).toBe(
      "老板通知新增铃声\n左上角显示版本号。",
    );
    expect(normalizeReleaseNotes("  新增铃声\n提醒  ")).toBe("新增铃声\n提醒");
  });

  it("keeps electron-updater note arrays as separate items without markup", () => {
    expect(
      normalizeReleaseNotes([
        { version: "0.1.18", note: "<p>新增铃声</p><ul><li>1. 连接更稳定</li><li>2. 修复 <b>闪退</b></li></ul>" },
        { version: "0.1.17", note: "旧版说明" },
        { version: "0.1.16" },
      ]),
    ).toBe("新增铃声\n连接更稳定\n修复 闪退\n旧版说明");
  });

  it("drops author numbering and bullets so the list is not numbered twice", () => {
    expect(
      splitReleaseNoteItems("1. 第一项\n2、第二项\n（3）第三项\n- 第四项\n• 第五项\n③ 第六项"),
    ).toEqual(["第一项", "第二项", "第三项", "第四项", "第五项", "第六项"]);
    // Numbers that belong to the sentence are not list markers.
    expect(splitReleaseNoteItems("3 条追问建议\n1.5 倍速播放\n-5% 体积")).toEqual([
      "3 条追问建议",
      "1.5 倍速播放",
      "-5% 体积",
    ]);
  });

  it("limits remote text at an item boundary before it reaches the renderer", () => {
    const notes = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 项${"改进".repeat(60)}`).join("\n");
    const normalized = normalizeReleaseNotes(notes);
    expect(normalized.length).toBeLessThanOrEqual(2_000);
    expect(normalized.split("\n").every((line) => line.startsWith("第 "))).toBe(true);
    expect(normalizeReleaseNotes("一".repeat(3_000)).length).toBeLessThanOrEqual(300);
    expect(normalizeReleaseNotes(Array.from({ length: 30 }, (_, i) => `项${i}`).join("\n")).split("\n")).toHaveLength(20);
  });

  it("returns an empty string for missing or malformed notes", () => {
    expect(normalizeReleaseNotes(undefined)).toBe("");
    expect(normalizeReleaseNotes(null)).toBe("");
    expect(normalizeReleaseNotes([{ note: 42 }, 7])).toBe("");
  });

  it("uses the same item rules in the main process and the renderer", () => {
    for (const fixture of [
      MULTI_LINE_NOTES,
      MULTI_LINE_NOTES.replace(/\n/g, "\r\n"),
      "老板通知新增铃声；左上角显示版本号。",
      "1. 第一项\n2、第二项\n（3）第三项",
      "<ul><li>连接更稳定</li><li>修复闪退</li></ul>",
    ]) {
      expect(releaseNoteItems(fixture)).toEqual(splitReleaseNoteItems(fixture));
      expect(releaseNoteItems(normalizeReleaseNotes(fixture))).toEqual(splitReleaseNoteItems(fixture));
    }
  });
});
