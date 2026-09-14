import { useEffect, useRef, useState } from "react";
import type { AiVideoJob, AiVideoSettings } from "../../../shared/aiVideo";
import { useAuth } from "../../auth/AuthContext";
import { aiDiagnosticDescription } from "./usageFormatting";

export function AdminAiVideoSettings() {
  const { api, session } = useAuth(); const account = session?.user.id;
  const [settings, setSettings] = useState<AiVideoSettings | null>(null), [enabled, setEnabled] = useState(false), [points, setPoints] = useState(""), [key, setKey] = useState("");
  const [pending, setPending] = useState<Array<AiVideoJob & { userId: string }>>([]), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState<{ job: AiVideoJob & { userId: string }; action: "charge" | "release" } | null>(null);
  const busyRef = useRef(false), openedAccount = useRef(account);
  const headers = { "X-Tongpin-Account": account ?? "" };
  useEffect(() => {
    const c = new AbortController();
    api<{ settings: AiVideoSettings; pending: typeof pending }>("/api/admin/ai/video", { headers: { "X-Tongpin-Account": account ?? "" }, signal: c.signal }).then(r => { if (!c.signal.aborted) { setSettings(r.settings); setEnabled(r.settings.enabled); setPoints(String(r.settings.quotaPoints || "")); setPending(r.pending); } }).catch(e => { if (!c.signal.aborted) setNotice(e instanceof Error ? e.message : "视频配置读取失败"); });
    return () => c.abort();
  }, [api, account]);
  async function action(fn: () => Promise<void>) { if (busyRef.current) return; busyRef.current = true; setBusy(true); setNotice(""); try { await fn(); } catch (e) { setNotice(e instanceof Error ? e.message : "操作失败"); } finally { busyRef.current = false; setBusy(false); } }
  if (openedAccount.current !== account) return null;
  return <section className="tp-ai-admin-card" aria-label="视频生成接入">
    <header className="tp-ai-admin-heading"><div><h2>视频生成 · H3</h2><p>文字或图片参考生成 5–15 秒视频</p></div></header>
    {!settings ? <p role="status">{notice || "读取配置中…"}</p> : <>
      <form onSubmit={e => { e.preventDefault(); void action(async () => {
        const r = await api<{ settings: AiVideoSettings }>("/api/admin/ai/video", { method: "PUT", headers, body: JSON.stringify({ enabled, quotaPoints: Number(points), ...(key ? { apiKey: key } : {}) }) });
        setSettings(r.settings); setKey(""); setNotice("视频配置已保存");
      }); }}>
        <fieldset className="tp-ai-admin-fields" disabled={busy}>
          <label className="tp-ai-admin-field">视频 API 地址<input readOnly value="https://www.75api.com/v1" /></label>
          <label className="tp-ai-admin-field">模型 ID<input readOnly value="minimax_h3" /></label>
          <label className="tp-ai-admin-field">独立视频密钥<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder={settings.apiKeyConfigured ? "已在服务端安全保存，留空保留" : "粘贴好漫剧专用密钥"} /></label>
          <label className="tp-ai-admin-field">每段视频折算 · 同频点<input type="number" min="1" max="10000000" step="1" value={points} onChange={e => setPoints(e.target.value)} /></label>
          <label className="tp-ai-admin-toggle"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用视频生成</label>
        </fieldset>
        <p className="tp-ai-admin-hint">折算值是成员额度，不是人民币或服务商实际账单。一次生成预留一段额度，完成后结算；结果不明需人工核对。</p>
        <div className="tp-ai-admin-actions"><button type="submit" className="tp-ai-admin-button is-primary" disabled={busy}>保存视频配置</button>
          <button type="button" className="tp-ai-admin-button" disabled={busy || !settings.apiKeyConfigured || Boolean(key)} onClick={() => void action(async () => { const r = await api<{ message: string }>("/api/admin/ai/video/test", { method: "POST", headers }, 30000); setNotice(r.message); })}>测试已保存的视频密钥</button></div>
      </form>
      {notice ? <p role="status">{notice}</p> : null}
      {pending.length ? <details><summary>待核对的视频任务（{pending.length}）</summary>{pending.map(job => <article key={job.id} className="tp-ai-admin-usage-entry">
        <p>成员编号：{job.userId} · 任务编号：{job.id}</p><p>{job.error}</p>{job.diagnostic ? <p>{aiDiagnosticDescription(job.diagnostic)}</p> : null}
        <button type="button" className="tp-ai-admin-button" disabled={busy} onClick={() => setConfirmation({ job, action: "release" })}>服务商未收费，释放预留</button>
        <button type="button" className="tp-ai-admin-button" disabled={busy} onClick={() => setConfirmation({ job, action: "charge" })}>服务商已收费，确认扣额</button>
      </article>)}</details> : null}
      {confirmation ? <div role="alert"><p>请先核对服务商记录。确定{confirmation.action === "release" ? "释放预留" : "扣除"} {confirmation.job.quotaPoints} 同频点？</p>
        <button className="tp-ai-admin-button" disabled={busy} onClick={() => void action(async () => {
          const id = confirmation.job.id;
          await api(`/api/admin/ai/videos/${encodeURIComponent(confirmation.job.userId)}/${encodeURIComponent(id)}/reconcile`, { method: "POST", headers, body: JSON.stringify({ action: confirmation.action }) });
          setPending(items => items.filter(j => j.id !== id)); setConfirmation(null); setNotice("人工核对已记入成员用量记录");
        })}>确认结算</button><button className="tp-ai-admin-button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div> : null}
    </>}
  </section>;
}
