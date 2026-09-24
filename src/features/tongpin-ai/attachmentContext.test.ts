import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { conversationAttachmentContext, fitAttachmentContext, fitGeneratedMediaAttachmentContext, toolAttachmentContext } from "./attachmentContext";
import { parseChatCapabilities } from "../../../server/ai/capabilities";
const frame = (value: string) => `data:image/jpeg;base64,${btoa(value)}`;
const validFrame = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
describe("bounded conversation context", () => {
  it("keeps current generated frames and one recent source without mutating history", () => {
    const history = Array.from({ length: 5 }, (_, i) => ({ name: `logo${i}`, dataUrl: frame(`image${i}`), text: "source" }));
    const visual = Array.from({ length: 4 }, (_, i) => ({ name: `video${i}`, dataUrl: frame(`frame${i}`), text: "actual video" }));
    const result = fitAttachmentContext(visual, history);
    expect(result).toHaveLength(5);
    expect(result.map(a => a.dataUrl)).toEqual([frame("frame0"), frame("frame1"), frame("frame2"), frame("frame3"), frame("image0")]);
    expect(result[0].text).toContain("4 份历史附件未重送");
    expect(visual[0].text).toBe("actual video"); expect(history).toHaveLength(5);
  });
  it("deduplicates visual bytes and caps history independently of explicit uploads", () => {
    expect(fitAttachmentContext([{ name: "new", dataUrl: frame("same") }], [{ name: "old", dataUrl: frame("same") }])).toHaveLength(1);
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `file${i}`, content: "text", mimeType: "text/plain" }));
    expect(conversationAttachmentContext([], docs)).toHaveLength(5);
    expect(docs).toHaveLength(10);
    expect(() => conversationAttachmentContext(docs, [])).toThrow("5");
  });
  it("skips corrupt historical records while preserving valid current context", () => {
    const current = [{ id: "current", name: "current.txt", content: "本轮资料", mimeType: "text/plain" }];
    const broken = [null, { id: "broken", name: "empty.txt", content: "", mimeType: "text/plain" }] as never;
    const result = conversationAttachmentContext(current, broken);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("本轮资料");
    expect(result[0].text).toContain("2 份历史附件未重送");
    expect(current[0].content).toBe("本轮资料");
  });
  it("keeps a UTF-8 CJK boundary within 48 KB after appending the omission notice", () => {
    const result = fitAttachmentContext([{ name: "current.txt", text: "汉".repeat(16_000) }], [{ name: "old.txt", text: "history" }]);
    const total = result.reduce((bytes, item) => bytes + new TextEncoder().encode(item.text || "").length, 0);
    expect(total).toBeLessThanOrEqual(48_000);
    expect(result[0].text?.length).toBeLessThanOrEqual(24_000);
    expect(result[0].text).toContain("1 份历史附件未重送");
    expect(result[0].text).not.toContain("\uFFFD");
    expect(() => parseChatCapabilities({ attachments: result })).not.toThrow();
  });
  it("builds byte-for-byte equivalent planning and execution attachment context", () => {
    const current = [{ id: "current", name: "current.txt", content: "本轮资料", mimeType: "text/plain" }];
    const project = [{ id: "project", name: "project.txt", content: "项目资料", mimeType: "text/plain" }];
    const history = [{ attachments: [{ id: "history", name: "history.txt", content: "历史资料", mimeType: "text/plain" }] }];
    const planned = toolAttachmentContext(current, project, history);
    const executed = toolAttachmentContext(current, project, [...history, { attachments: current }]);
    expect(executed).toEqual(planned);
    expect(executed.map(item => item.name)).toEqual(["current.txt", "history.txt", "project.txt"]);
  });
  it("preserves every explicit current upload before selecting generated video frames", () => {
    const current = [
      { name: "brief.txt", text: "本轮品牌要求" },
      { name: "budget.txt", text: "本轮预算要求" },
    ];
    const visual = Array.from({ length: 4 }, (_, i) => ({ name: `frame${i}`, dataUrl: validFrame, text: `视频采样画面 ${i + 1}/4` }));
    const result = fitGeneratedMediaAttachmentContext(current, visual, [{ name: "old.txt", text: "历史资料" }]);
    expect(result).toHaveLength(5);
    expect(result.slice(0, 2)).toEqual(current);
    expect(result.slice(2).map(item => item.name)).toContain("frame0");
    expect(result.slice(2).map(item => item.name)).toContain("frame3");
    expect(result.filter(item => item.dataUrl)).toHaveLength(3);
    expect(result.find(item => item.text?.includes("历史附件未重送"))).toBeDefined();
    expect(result.every(item => !item.text?.includes("本轮按相关性和最近顺序选取附件，1 份历史附件未重送") || item.name !== "budget.txt")).toBe(true);
    expect(() => parseChatCapabilities({ attachments: result })).not.toThrow();
  });
  it("does not misclassify a second current upload as omitted history", () => {
    const current = [
      { id: "a", name: "a.txt", content: "本轮 A", mimeType: "text/plain" },
      { id: "b", name: "b.txt", content: "本轮 B", mimeType: "text/plain" },
    ];
    const visual = Array.from({ length: 4 }, (_, i) => ({ name: `frame${i}`, dataUrl: frame(`frame${i}`), text: `视频采样画面 ${i + 1}/4` }));
    const result = toolAttachmentContext(current, [], [], visual);
    expect(result.map(item => item.name).slice(0, 2)).toEqual(["a.txt", "b.txt"]);
    expect(result).toHaveLength(5);
    expect(result.every(item => !item.text?.includes("历史附件未重送"))).toBe(true);
  });
  it("does not mix unrelated historical imagery into an explicit new upload", () => {
    const current = [{ id: "uploaded", name: "new.png", content: "", mimeType: "image/png", media: { kind: "image" as const, frames: [{ dataUrl: validFrame }] } }];
    const history = [{ attachments: [{ id: "old", name: "old.png", content: "", mimeType: "image/png", media: { kind: "image" as const, frames: [{ dataUrl: frame("different-history-image") }] } }] }];
    const onlyNew = toolAttachmentContext(current, [], history);
    expect(onlyNew.map(item => item.name)).toEqual(["new.png"]);
    const comparison = toolAttachmentContext(current, [], history, [{ name: "generated-video-frame", dataUrl: validFrame, text: "旧生成视频的采样画面" }]);
    expect(comparison.map(item => item.name)).toEqual(["new.png", "generated-video-frame"]);
    expect(comparison.some(item => item.text?.includes("历史附件未重送"))).toBe(false);
  });
  it("refuses to silently drop current uploads when no video frame can fit", () => {
    const current = Array.from({ length: 5 }, (_, i) => ({ name: `current${i}`, text: `本轮 ${i}` }));
    const visual = [{ name: "frame", dataUrl: frame("frame"), text: "视频画面" }];
    expect(() => fitGeneratedMediaAttachmentContext(current, visual, [])).toThrow("移除至少 1 份");
    expect(current).toHaveLength(5);
  });
  it("fails clearly instead of shortening current uploads to squeeze in generated imagery", () => {
    const current = [{ name: "first.txt", text: "a".repeat(24_000) }, { name: "second.txt", text: "b".repeat(24_000) }];
    expect(() => fitGeneratedMediaAttachmentContext(current, [{ name: "frame", dataUrl: validFrame, text: "真实采样画面" }], [])).toThrow("超出分析上限");
    expect(current[0].text).toHaveLength(24_000);
    expect(current[1].text).toHaveLength(24_000);
  });
  it("does not tell members to start a new conversation for historical frames", () => {
    const source = readFileSync(new URL("./attachments.ts", import.meta.url), "utf8");
    expect(source).not.toContain("请新建对话");
  });
});
