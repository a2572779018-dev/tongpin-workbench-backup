/** Synthetic service-check fixture. No provider calls, credentials or persisted user data. */
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AiAvailability, AiStatus } from "../shared/ai";
import { useAiAvailability } from "../src/features/tongpin-ai/useAiAvailability";
import { AiAvailabilityNotice } from "../src/features/tongpin-ai/AiAvailabilityNotice";
import "../src/styles.css";

const status: AiStatus = { accessGranted: true, configured: true, quickModel: "fixture", deepModel: "fixture", maxOutputTokens: 1024,
  quota: { limitTokens: 1000, usedTokens: 0, reservedTokens: 0, remainingTokens: 1000, inputTokens: 0, outputTokens: 0 } };
function Fixture() {
  const [draft, setDraft] = useState("保留我的草稿");
  const [, setStatus] = useState(status);
  const scenario = useRef<"unavailable" | "reachable" | "unverified">("unavailable");
  const [calls, setCalls] = useState(0);
  const api = useCallback(async <T,>(_path: string, options?: RequestInit): Promise<T> => {
    const state = scenario.current; setCalls(value => value + 1);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      const timer = setTimeout(() => { options?.signal?.removeEventListener("abort", abort); resolve(); }, 1800);
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
    });
    const result: AiAvailability = { status, check: { state, code: state, checkedAt: new Date().toISOString(), message: state === "unavailable" ? "服务商安全网关拦截（HTTP 403），请联系管理员核查。" : state === "unverified" ? "服务商不支持连接检测，生成能力尚未验证；可尝试发送。" : "连接检查通过，生成能力以实际请求结果为准。" } };
    return result as T;
  }, []);
  const availability = useAiAvailability(api, "fixture-member", "chat", setStatus);
  const blocked = availability.checking || availability.check?.state === "unavailable";
  return <main style={{ background: "#faf7ee", minHeight: "100vh", padding: 40 }}>
    <h2>服务检查验收 · 模拟数据</h2>
    <label>模拟服务状态 <select aria-label="模拟服务状态" onChange={event => { scenario.current = event.target.value as typeof scenario.current; }} defaultValue="unavailable">
      <option value="unavailable">网关拦截</option><option value="reachable">连接恢复</option><option value="unverified">检测不受支持</option>
    </select></label>
    <p>检测次数：{calls} · 生成次数：0</p>
    <section style={{ maxWidth: 800, margin: "40px auto" }}><p>历史对话：昨天整理的工作安排（始终可查看）</p>
      <AiAvailabilityNotice checking={availability.checking} check={availability.check} onRetry={() => void availability.refresh("quick:chat")} />
      <textarea aria-label="草稿" value={draft} onChange={event => setDraft(event.target.value)} style={{ width: "100%", minHeight: 120, background: "#fffcf5", borderRadius: 16, padding: 20 }} />
      <button type="button" disabled={blocked || !draft.trim()}>发送（仅演示禁用状态）</button>
    </section>
  </main>;
}
const root = createRoot(document.getElementById("root")!); root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
