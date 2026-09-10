/** Development-only rendering fixture. No authentication, persisted data or provider calls. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatMessageRow } from "../src/features/tongpin-ai/ChatMessageRow";
import "../src/styles.css";
import "../src/features/tongpin-ai/tongpin-ai.css";
import "../src/features/tongpin-ai/chat-layout.css";
import "../src/features/tongpin-ai/ai-metal-theme.css";
import "../src/features/tongpin-ai/ai-refinements.css";

const content = `我整理好了，**先核实资料，再决定下一步**。公开信息可以帮助了解背景，但不能代替实际核验。([来源示例](https://example.com/reference))

## 重点看这几件事

1. **核实主体信息**：名称、经营状态和收款主体。
2. **明确交付范围**：功能、时间、售后与数据归属。
3. 保留原始资料，遇到不确定的信息再核实。

> 这是一条引用说明，来源链接可以点击查看。

| 检查项目 | 当前状态 |
| --- | --- |
| 资料清单 | 已整理 |
| 合同内容 | 待核实 |

**结论：先从一个小项目开始。 **

代码中的标记应该保留原样：\`**literal**\`。

\`\`\`js
const message = "**代码不应被改写**";
\`\`\``;

function Preview() {
  const [run, setRun] = useState(0);
  const [typing, setTyping] = useState(false);
  return <main className="tp-ai-page" style={{ display: "block", background: "#faf7ee", padding: "28px clamp(16px, 5vw, 70px)", minHeight: "100vh" }}>
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
        <span>回复排版 · 隔离样例</span><button onClick={() => { setRun(value => value + 1); setTyping(true); }}>演示打字</button>
        <button onClick={() => setTyping(false)}>显示完整回复</button>
      </div>
      <ChatMessageRow key={run} message={{ id: "fixture", role: "assistant", content, status: typing ? "typing" : "ready", time: "12:00" }}
        assistantName="同频 AI" copied={false} retryable={false} retryDisabled={false}
        onCopy={() => {}} onOpenArtifact={() => {}} onRetry={() => {}} />
    </div>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
