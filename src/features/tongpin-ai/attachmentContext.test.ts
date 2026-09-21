import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { conversationAttachmentContext, fitAttachmentContext, toolAttachmentContext } from "./attachmentContext";
import { parseChatCapabilities } from "../../../server/ai/capabilities";
const frame = (value: string) => `data:image/jpeg;base64,${btoa(value)}`;
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
  it("does not tell members to start a new conversation for historical frames", () => {
    const source = readFileSync(new URL("./attachments.ts", import.meta.url), "utf8");
    expect(source).not.toContain("请新建对话");
  });
});
