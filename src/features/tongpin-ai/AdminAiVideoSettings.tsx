import { Clapperboard, RefreshCw, Save } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AiAdminVideoReconciliationJob, AiVideoModelCheck, AiVideoSettings } from "../../../shared/aiVideo";
import { videoModel } from "../../../shared/aiVideoModels";
import { useAuth } from "../../auth/AuthContext";
import type { AiHarnessConfig, AiMember } from "../../../shared/ai";
import { adminAiErrorMessage, parseAdminPoints } from "./adminAiForms";
import { AdminAiPendingVideoJobSummary, AdminAiTierVideoNote, tiersManageRouting, tierVideoRoutes } from "./adminAiLayout";

/** AI 管理 → 图片与视频 → 视频: on/off, the per-clip price, re-reading the
 * models of the connections the tiers use, and manual reconciliation. */
export function AdminAiVideoSettings({ harnessConfig = null, members = [] }: { harnessConfig?: AiHarnessConfig | null; members?: AiMember[] } = {}) {
  const { api, session } = useAuth(); const account = session?.user.id;
  const id = useId();
  const [settings, setSettings] = useState<AiVideoSettings | null>(null);
  const [loadError, setLoadError] = useState(""), [loadVersion, setLoadVersion] = useState(0);
  const [enabled, setEnabled] = useState(false), [points, setPoints] = useState(""), [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<AiAdminVideoReconciliationJob[]>([]);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState<{ job: AiAdminVideoReconciliationJob; action: "charge" | "release" } | null>(null);
  const [modelCheck, setModelCheck] = useState<AiVideoModelCheck>();
  const busyRef = useRef(false), openedAccount = useRef(account);
  const headers = { "X-Tongpin-Account": account ?? "" };
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    api<{ settings: AiVideoSettings; pending: AiAdminVideoReconciliationJob[] }>("/api/admin/ai/video", { headers: { "X-Tongpin-Account": account ?? "" }, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setSettings(result.settings); setEnabled(result.settings.enabled); setPoints(result.settings.quotaPoints ? String(result.settings.quotaPoints) : ""); setDirty(false); setPending(result.pending); } })
      .catch(caught => { if (!controller.signal.aborted) setLoadError(adminAiErrorMessage(caught, "视频设置读取失败，请重试。")); });
    return () => controller.abort();
  }, [api, account, loadVersion]);
  async function action(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(""); setError("");
    try { await fn(); } catch (caught) { setError(adminAiErrorMessage(caught, "操作失败，请稍后重试。")); }
    finally { busyRef.current = false; setBusy(false); }
  }
  if (openedAccount.current !== account) return null;
  const ready = tiersManageRouting(harnessConfig);
  const routes = ready ? tierVideoRoutes(harnessConfig) : [];
  const videoTiers = routes.filter(route => route.enabled && route.opensVideo && route.modelId);
  const memberById = new Map(members.map(member => [member.id, member]));
  const checkModels = async () => {
    const result = await api<AiVideoModelCheck>("/api/admin/ai/video/test", { method: "POST", headers }, 30_000);
    setModelCheck(result);
    const missing = videoTiers.filter(route => !result.availableModels.includes(route.modelId as AiVideoModelCheck["availableModels"][number]));
    setNotice(missing.length
      ? `${result.message} 注意：${missing.map(route => `${route.tierLabel}档的 ${route.modelLabel}`).join("、")} 不在可用列表里，这些档位会自动换用可用的视频模型并告诉成员。`
      : result.message);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const price = parseAdminPoints(points, "每段视频折算的同频点", { min: enabled ? 1 : 0 });
    if (price.error) { setError(price.error); return; }
    await action(async () => {
      const result = await api<{ settings: AiVideoSettings }>("/api/admin/ai/video", { method: "PUT", headers, body: JSON.stringify({ enabled, quotaPoints: price.value }) });
      setSettings(result.settings); setDirty(false);
      setNotice(enabled ? "视频设置已保存。" : "视频设置已保存，成员暂时不能生成视频。");
    });
  }

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={busy || (!settings && !loadError)}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Clapperboard size={20} aria-hidden="true" />视频</h2>
      <p>这里管视频是否开放、每段折算多少同频点，以及结果不明、需要人工核对的视频任务。</p>
    </div></header>
    {!settings ? loadError ? <div className="tp-ai-admin-actions"><p className="tp-ai-admin-error" role="alert">{loadError}</p>
      <button className="tp-ai-admin-button" type="button" onClick={() => setLoadVersion(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />重新加载</button></div>
      : <p role="status">读取视频设置中…</p> : <>
      <form onSubmit={save} noValidate>
        {!ready ? <p className="tp-ai-admin-hint" role="note">请先在「服务与模型」接入服务并保存四个档位，再为档位选择视频服务和模型。</p> : null}
        <fieldset className="tp-ai-admin-fields" disabled={busy}>
          <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setDirty(true); setNotice(""); setError(""); }} />开放视频生成</label>
          <label className="tp-ai-admin-field" htmlFor={`${id}-points`}>每段视频折算 · 同频点
            <input id={`${id}-points`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 30000" value={points} onChange={event => { setPoints(event.target.value); setDirty(true); setNotice(""); setError(""); }} />
          </label>
          {ready ? <AdminAiTierVideoNote config={harnessConfig} /> : null}
          <p className="tp-ai-admin-hint is-wide">折算值是成员额度，不是人民币或服务商账单。一次生成先预留一段额度，完成后结算；生成失败会自动退回，结果不明的任务需要你在下方人工核对。</p>
        </fieldset>
        {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
        {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
        <div className="tp-ai-admin-actions">
          <button type="submit" className="tp-ai-admin-button is-primary" disabled={busy || !dirty}><Save size={17} aria-hidden="true" />{busy ? "处理中…" : "保存视频设置"}</button>
          <button type="button" className="tp-ai-admin-button" disabled={busy || !videoTiers.length} title={videoTiers.length ? "重新读取档位所用视频服务的模型列表，不生成视频" : "还没有档位开放生成视频"}
            onClick={() => void action(checkModels)}><RefreshCw size={16} aria-hidden="true" />检查视频模型</button>
        </div>
      </form>
      {modelCheck?.models ? <ul className="tp-ai-admin-model-check">{modelCheck.models.filter(model => model.listed || videoTiers.some(route => route.modelId === model.id)).map(model => {
        const spec = videoModel(model.id);
        return <li key={model.id}>{model.label} · {model.id}：{model.listed ? "服务商已列出" : "服务商未列出，请核对令牌的模型范围"}{spec && !spec.generationEnabled ? `；同频已暂停：${spec.unavailableReason}` : ""}</li>;
      })}</ul> : null}
      {pending.length ? <details className="tp-ai-provider-capabilities" open><summary>待核对的视频任务（{pending.length}）</summary>
        <p className="tp-ai-admin-hint">请先到服务商后台核对这段视频有没有收费，再选择结算方式。</p>
        {pending.map(job => <article key={job.id} className="tp-ai-admin-usage-entry">
          <AdminAiPendingVideoJobSummary job={job} member={memberById.get(job.userId)} />
          <div className="tp-ai-admin-row-actions">
            <button type="button" className="tp-ai-admin-button" disabled={busy} onClick={() => setConfirmation({ job, action: "release" })}>服务商未收费，释放预留</button>
            <button type="button" className="tp-ai-admin-button" disabled={busy} onClick={() => setConfirmation({ job, action: "charge" })}>服务商已收费，确认扣额</button>
          </div>
        </article>)}
      </details> : null}
      {confirmation ? <div className="tp-ai-admin-confirm" role="alertdialog" aria-label="确认结算">
        <p>确定为 {memberById.get(confirmation.job.userId)?.name ?? "该成员"}{confirmation.action === "release" ? "释放预留的" : "扣除"} {confirmation.job.quotaPoints} 同频点？</p>
        <div className="tp-ai-admin-row-actions">
          <button className="tp-ai-admin-button is-primary" type="button" disabled={busy} onClick={() => void action(async () => {
            const jobId = confirmation.job.id;
            await api(`/api/admin/ai/videos/${encodeURIComponent(confirmation.job.userId)}/${encodeURIComponent(jobId)}/reconcile`, { method: "POST", headers, body: JSON.stringify({ action: confirmation.action }) });
            setPending(items => items.filter(item => item.id !== jobId)); setConfirmation(null); setNotice("人工核对已记入成员用量记录。");
          })}>确认结算</button>
          <button className="tp-ai-admin-button" type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
        </div>
      </div> : null}
    </>}
  </section>;
}
