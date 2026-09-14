import type { AiAvailabilityCheck } from "../../../shared/ai";
import "./ai-availability.css";

export function AiAvailabilityNotice({ checking, check, onRetry }: {
  checking: boolean; check: AiAvailabilityCheck | null; onRetry: () => void;
}) {
  const state = checking ? "checking" : check?.state ?? "unavailable";
  if (state === "reachable") return null;
  return <div className={`tp-ai-availability is-${state}`} role="status">
    <div><strong>{checking ? "正在检查服务连接…" : state === "unverified" ? "生成能力尚未验证" : "当前功能暂不可用"}</strong>
      {!checking && check && <small>{check.message}</small>}
      {checking && <small>检测期间暂不能发送，历史对话可正常查看。</small>}
    </div>
    <button type="button" onClick={onRetry} disabled={checking}>重新检测</button>
  </div>;
}
