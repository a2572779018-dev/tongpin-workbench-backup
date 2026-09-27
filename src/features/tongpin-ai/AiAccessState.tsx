import { LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";

/**
 * What the AI page shows before its workspace is ready. Loading is the common
 * case (every visit reads access, persona and workspace, about a second): it
 * reads as "opening", waits a moment before it fades in so a quick load never
 * flashes it (ai-refinements.css), and keeps the lock for a real lock.
 */
export function AiAccessState({ name, loading, error, locked, retried, onRetry }: {
  name: string;
  loading: boolean;
  error?: string;
  locked?: boolean;
  /** A retry the member asked for: show the loading card at once, not after a pause. */
  retried?: boolean;
  onRetry: () => void;
}) {
  return <section className={`tp-ai-entry${loading ? " is-loading" : ""}${loading && retried ? " is-retry" : ""}`} aria-label="同频 AI 开通状态" aria-busy={loading}>
    <div className="tp-ai-entry__card">
      <span className="tp-ai-entry__icon">{loading
        ? <LoaderCircle className="tp-ai-entry__spinner" size={26} aria-hidden="true" />
        : <LockKeyhole size={26} aria-hidden="true" />}</span>
      <p className="tp-ai-entry__eyebrow">同频 AI</p>
      <h1>{loading ? "正在打开同频 AI" : error ? "暂时无法连接" : "你的 AI 还未开通"}</h1>
      <p role={error ? "alert" : "status"}>{loading ? "正在确认访问权限，并同步你的对话。" : error || "请联系管理员分配 AI 额度，开通后即可设置你的专属 AI。"}</p>
      {!loading && <button type="button" onClick={onRetry}><RefreshCw size={16} />{locked && !error ? "已开通，重新检查" : "重新尝试"}</button>}
    </div>
    <div className="tp-ai-entry__account">当前账号 · {name}</div>
  </section>;
}
