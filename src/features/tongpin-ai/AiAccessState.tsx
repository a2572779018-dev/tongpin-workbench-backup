import { LockKeyhole, RefreshCw } from "lucide-react";

export function AiAccessState({ name, loading, error, locked, onRetry }: {
  name: string;
  loading: boolean;
  error?: string;
  locked?: boolean;
  onRetry: () => void;
}) {
  return <section className="tp-ai-entry" aria-label="同频 AI 开通状态" aria-busy={loading}>
    <div className="tp-ai-entry__card">
      <span className="tp-ai-entry__icon"><LockKeyhole size={26} aria-hidden="true" /></span>
      <p className="tp-ai-entry__eyebrow">同频 AI</p>
      <h1>{loading ? "正在确认访问权限" : error ? "暂时无法连接" : "你的 AI 还未开通"}</h1>
      <p role={error ? "alert" : "status"}>{loading ? "稍候片刻，正在同步你的账号状态。" : error || "请联系管理员分配 AI 额度，开通后即可设置你的专属 AI。"}</p>
      {!loading && <button type="button" onClick={onRetry}><RefreshCw size={16} />{locked && !error ? "已开通，重新检查" : "重新尝试"}</button>}
    </div>
    <div className="tp-ai-entry__account">当前账号 · {name}</div>
  </section>;
}
