/** Synthetic acceptance fixture: no credentials, persistence or provider requests. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessageRow } from "../src/features/tongpin-ai/ChatMessageRow";
import { waitForReply } from "../src/features/tongpin-ai/waitForReply";
import type { AiChatResponse } from "../shared/ai";
import "../src/styles.css";
import "../src/features/tongpin-ai/tongpin-ai.css";
import "../src/features/tongpin-ai/chat-layout.css";
import "../src/features/tongpin-ai/ai-metal-theme.css";
import "../src/features/tongpin-ai/ai-refinements.css";

function Preview() {
  const [status, setStatus] = useState<"thinking" | "ready" | "error">("ready");
  const [content, setContent] = useState("点击模拟等待，6 秒后自动显示回复。");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function start() {
    const run = new AbortController(); controller.current = run;
    setStatus("thinking"); let reads = 0;
    try {
      const result = await waitForReply(async () => ++reads <= 3
        ? { requestId: "fixture", status: "pending" }
        : { requestId: "fixture", status: "completed", result: { requestId: "fixture", content: "你好！**回复已自动取回**，没有重复生成请求。" } as AiChatResponse }, run.signal);
      setContent("content" in result ? result.content : "图片完成"); setStatus("ready");
    } catch { setContent("已停止等待。"); setStatus("error"); }
  }
  return <main className="tp-ai-page" style={{ display: "block", background: "#faf7ee", minHeight: "100vh", padding: 48, fontFamily: "sans-serif" }}>
    <h2>等待流程验收（模拟数据）</h2>
    <button disabled={status === "thinking"} onClick={() => void start()}>模拟等待</button>{" "}
    <button disabled={status !== "thinking"} onClick={() => controller.current?.abort()}>停止等待</button>
    <section style={{ maxWidth: 820, margin: "40px auto" }}><ChatMessageRow
      message={{ id: "fixture", role: "assistant", time: "12:00", status, content }}
      assistantName="同频 AI" copied={false} retryable={false} retryDisabled={false}
      onCopy={() => {}} onOpenArtifact={() => {}} onRetry={() => {}} /></section>
  </main>;
}
const root = createRoot(document.getElementById("root")!); root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
