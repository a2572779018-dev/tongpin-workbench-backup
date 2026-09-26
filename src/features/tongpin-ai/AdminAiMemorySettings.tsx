import { Brain, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AI_BUSINESS_TIER_LABELS, AI_BUSINESS_TIERS, type AiMode } from "../../../shared/ai";
import { AI_MEMORY_PRICE_MAX, type AiMemoryAdminSettings, type AiMemoryAdminStats } from "../../../shared/aiMemory";
import { useAuth } from "../../auth/AuthContext";
import { formatAiPoints } from "./quotaFormatting";
import "./member-memory.css";

type View = { settings: AiMemoryAdminSettings; stats: AiMemoryAdminStats };
const number = (value: number) => value.toLocaleString("zh-CN");

/**
 * Administrator controls for member memory: organization switch, reviewer
 * tier and per-update price, plus organization aggregates. There is no way to
 * read a member's memory from here.
 */
export function AdminAiMemorySettings() {
  const { api, session } = useAuth();
  const account = session?.user.id ?? "";
  const id = useId();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; reviewTier: AiMode; pricePoints: string }>({ enabled: false, reviewTier: "quick", pricePoints: "100" });
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const headers = { "X-Tongpin-Account": account };

  const apply = useCallback((next: View) => {
    setView(next);
    setDraft({ enabled: next.settings.enabled, reviewTier: next.settings.reviewTier, pricePoints: String(next.settings.pricePoints) });
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const next = await api<View>("/api/admin/ai/memory", { headers: { "X-Tongpin-Account": account }, signal }); if (!signal?.aborted) apply(next); }
    catch (error) { if (!signal?.aborted) setNotice({ kind: "error", text: error instanceof Error ? error.message : "记忆设置读取失败" }); }
  }, [api, account, apply]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const pricePoints = Number(draft.pricePoints);
    if (!Number.isSafeInteger(pricePoints) || pricePoints < 0 || pricePoints > AI_MEMORY_PRICE_MAX) { setNotice({ kind: "error", text: `每次更新记忆的折算需为 0 到 ${number(AI_MEMORY_PRICE_MAX)} 的整数` }); return; }
    busyRef.current = true; setBusy(true); setNotice(null);
    try {
      apply(await api<View>("/api/admin/ai/memory", { method: "PUT", headers, body: JSON.stringify({ enabled: draft.enabled, reviewTier: draft.reviewTier, pricePoints }) }));
      setNotice({ kind: "success", text: draft.enabled ? "记忆设置已保存，成员的新对话将开始参考并整理记忆" : "记忆设置已保存；已关闭学习和使用，成员仍可查看和删除已有记忆" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "记忆设置保存失败" });
    } finally { busyRef.current = false; setBusy(false); }
  }

  const dirty = view !== null && (draft.enabled !== view.settings.enabled || draft.reviewTier !== view.settings.reviewTier || draft.pricePoints !== String(view.settings.pricePoints));
  const stats = view?.stats;
  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={!view || busy}>
    <header className="tp-ai-admin-heading">
      <div><h2 id={`${id}-title`}><Brain size={21} aria-hidden="true" />记忆 · 越用越懂成员</h2>
        <p>开启后，成员每次完成有内容的对话，同频 AI 会在后台用所选档位的文字模型整理值得长期记住的信息（参考开源 Hermes Agent 的学习循环），并在之后的新对话中参考。记忆只有成员本人能查看和修改，管理员这里只显示汇总数字。</p></div>
      <button className="tp-ai-admin-button" type="button" disabled={busy} onClick={() => { setNotice(null); void load(); }}><RefreshCw size={17} aria-hidden="true" />刷新</button>
    </header>
    {notice ? <p className={notice.kind === "error" ? "tp-ai-admin-error" : "tp-ai-admin-success"} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}
    {!view ? (notice ? null : <p role="status">读取配置中…</p>) : <>
      <form onSubmit={event => void save(event)}>
        <fieldset className="tp-ai-admin-fields" disabled={busy}>
          <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} />为本组织启用成员记忆</label>
          <label className="tp-ai-admin-field" htmlFor={`${id}-tier`}>记忆整理使用的档位
            <select id={`${id}-tier`} value={draft.reviewTier} onChange={event => setDraft(current => ({ ...current, reviewTier: event.target.value as AiMode }))}>
              {AI_BUSINESS_TIERS.map(tier => <option key={tier} value={tier}>{AI_BUSINESS_TIER_LABELS[tier]}</option>)}
            </select></label>
          <label className="tp-ai-admin-field" htmlFor={`${id}-price`}>每次更新记忆折算 · 同频点
            <input id={`${id}-price`} type="number" min="0" max={AI_MEMORY_PRICE_MAX} step="1" value={draft.pricePoints} onChange={event => setDraft(current => ({ ...current, pricePoints: event.target.value }))} /></label>
          <p className="tp-ai-admin-hint is-wide">建议使用「快速」档位控制成本。只有记忆真的被更新时才向成员扣点，设为 0 表示不扣点（模型用量仍由组织承担）。寒暄和很短的对话不会触发整理，每位成员每天最多整理 40 次；密码、验证码、证件与银行卡号等敏感信息一律不保存。</p>
        </fieldset>
        <footer className="tp-ai-admin-actions">
          <button className="tp-ai-admin-button is-primary" type="submit" disabled={busy || !dirty}>{busy ? "保存中…" : "保存记忆设置"}</button>
          <span className="tp-ai-admin-hint">{dirty ? "有未保存的修改" : view.settings.enabled ? "已启用" : "未启用"}</span>
        </footer>
      </form>
      {stats ? <dl className="tp-ai-memory-admin-stats" aria-label="记忆使用汇总">
        <div><dt>有记忆的成员</dt><dd>{number(stats.membersWithMemory)}</dd></div>
        <div><dt>关闭了记忆的成员</dt><dd>{number(stats.membersLearningOff)}</dd></div>
        <div><dt>记忆条目总数</dt><dd>{number(stats.totalEntries)}</dd></div>
        <div><dt>近 7 天整理</dt><dd>{number(stats.reviews7d.applied)} 次有更新<small>无变化 {number(stats.reviews7d.unchanged)} · 跳过 {number(stats.reviews7d.skipped)} · 失败 {number(stats.reviews7d.failed)}</small></dd></div>
        <div><dt>近 7 天向成员扣点</dt><dd>{formatAiPoints(stats.points7d)}</dd></div>
        <div><dt>近 7 天整理模型用量</dt><dd>{number(stats.tokens7d.input + stats.tokens7d.output)} Token<small>输入 {number(stats.tokens7d.input)} · 输出 {number(stats.tokens7d.output)}</small></dd></div>
      </dl> : null}
    </>}
  </section>;
}
