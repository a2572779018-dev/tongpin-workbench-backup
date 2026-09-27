import { Check, Info, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AI_MEMORY_LIMITS, AI_MEMORY_TARGET_LABELS, type AiMemoryEntryOperation, type AiMemoryState, type AiMemoryTarget } from "../../../shared/aiMemory";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import type { User } from "../../types";
import { memberMemoryApi, memoryEntryLength, memoryUsagePercent } from "./memberMemoryClient";
import { memberLearningApi, refreshPersonalSkills } from "./memberLearningClient";
import { MemberRecallSection } from "./MemberRecallSection";
import { MemberSkillsSection } from "./MemberSkillsSection";
import type { AiMemorySkillOperation } from "../../../shared/aiMemoryLearning";
import { formatAiPoints } from "./quotaFormatting";
import "./member-memory.css";

const STORE_HINTS: Record<AiMemoryTarget, { hint: string; empty: string; placeholder: string }> = {
  user: {
    hint: "称呼、角色、沟通风格和对 AI 的偏好",
    empty: "还没有记录。对 AI 说“记住……”或“以后……”，它会记下你的偏好。",
    placeholder: "例如：我负责市场部品牌合作，回复请先给结论",
  },
  memory: {
    hint: "项目背景、团队约定和合作中积累的经验",
    empty: "还没有笔记。随着合作，AI 会记下项目背景和约定。",
    placeholder: "例如：周报每周五发给老板，需附下周计划",
  },
};

type Editing = { target: AiMemoryTarget; index: number; original: string; text: string };

/**
 * 「AI 对你的了解」: the member's own view of both memory stores. Only the
 * signed-in member can read or change it; administrators and bosses have no
 * access. Every write carries the revision it was based on.
 */
export function MemberMemoryPanel({ user, onClose }: { user: User; onClose: () => void }) {
  const { api } = useAuth();
  const client = memberMemoryApi(api, user.id);
  const titleId = useId();
  const [state, setState] = useState<AiMemoryState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drafts, setDrafts] = useState<Record<AiMemoryTarget, string>>({ user: "", memory: "" });
  const [confirmClear, setConfirmClear] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const editingRef = useRef(false); editingRef.current = editing !== null;

  const load = useCallback(async () => {
    setLoadError("");
    try { const next = await memberMemoryApi(api, user.id).read(); if (aliveRef.current) setState(next); }
    catch (error) { if (aliveRef.current) setLoadError(error instanceof Error ? error.message : "记忆暂时无法读取"); }
  }, [api, user.id]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault(); event.stopPropagation();
        // First Escape leaves an in-progress edit; the next one closes the panel.
        if (editingRef.current) setEditing(null); else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled)") ?? []).filter(item => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { aliveRef.current = false; document.removeEventListener("keydown", onKey, true); };
  }, [load]);

  async function run(action: () => Promise<AiMemoryState>, success?: string) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setNotice(null);
    try {
      const next = await action();
      if (!aliveRef.current) return false;
      setState(next);
      if (success) setNotice({ kind: "success", text: success });
      return true;
    } catch (error) {
      if (!aliveRef.current) return false;
      const conflict = error instanceof ApiRequestError && ["AI_MEMORY_CONFLICT", "AI_MEMORY_SKILL_CONFLICT", "AI_MEMORY_SKILL_NOT_FOUND"].includes(error.code);
      if (conflict) await load();
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "操作失败，请稍后重试" });
      return false;
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }
  const update = (operation: AiMemoryEntryOperation, success: string) => state ? run(() => client.update(state.revision, operation), success) : Promise.resolve(false);
  const updateSkill = async (operation: AiMemorySkillOperation, success: string) => {
    const ok = await run(() => memberLearningApi(api, user.id).updateSkill(operation), success);
    // The @ list follows adoptions, edits and deletions.
    if (ok) void refreshPersonalSkills();
    return ok;
  };

  async function addEntry(event: FormEvent<HTMLFormElement>, target: AiMemoryTarget) {
    event.preventDefault();
    const content = drafts[target].trim();
    if (!content) return;
    if (await update({ action: "add", target, content }, "已记下")) setDrafts(current => ({ ...current, [target]: "" }));
  }
  async function saveEdit() {
    if (!editing) return;
    const content = editing.text.trim();
    const ok = content
      ? await update({ action: "replace", target: editing.target, index: editing.index, expectedEntry: editing.original, content }, "已更新")
      : await update({ action: "remove", target: editing.target, index: editing.index, expectedEntry: editing.original }, "已删除");
    if (ok) setEditing(null);
  }

  const total = state ? state.stores.memory.entries.length + state.stores.user.entries.length : 0;
  const adoptedSkills = state?.skills?.items.filter(skill => skill.status === "adopted").length ?? 0;
  const learned = total + (state?.skills?.items.length ?? 0) + (state?.recall?.recent.length ?? 0) + (state?.recall?.indexedConversations ?? 0);
  const host = document.querySelector(".tp-ai-page") ?? document.body;
  return createPortal(<div className="tp-ai-usage-layer tp-ai-memory-layer">
    <div className="tp-ai-usage-layer__backdrop" aria-hidden="true" onClick={() => { if (!busyRef.current) onClose(); }} />
    <section ref={dialogRef} className="tp-ai-usage-dialog tp-ai-memory-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || (!state && !loadError)}>
      <header className="tp-ai-usage-dialog__header">
        <span><h2 id={titleId}>AI 对你的了解</h2><small>{user.name} · 仅你本人可见</small></span>
        <button ref={closeRef} type="button" aria-label="关闭 AI 对你的了解" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      {!state ? <div className="tp-ai-memory-body">
        {loadError ? <><p role="alert" className="tp-ai-memory-notice is-error">{loadError}</p><button type="button" className="tp-ai-memory-button" onClick={() => void load()}>重新读取</button></> : <p role="status">正在读取…</p>}
      </div> : <div className="tp-ai-memory-body">
        <p className="tp-ai-memory-intro">同频 AI 会在对话结束后整理值得长期记住的信息，记下你常做的事的做法；你提到以前聊过的内容时，它会回忆相关对话。越用越懂你，你可以随时修改或删除。</p>
        {state.available ? <ul className="tp-ai-memory-summary" aria-label="AI 对你的了解概况">
          <li><strong>{total}</strong><span>条记忆</span></li>
          {state.recall ? <li><strong>{state.recall.indexedConversations.toLocaleString("zh-CN")}</strong><span>段对话可回忆</span></li> : null}
          {state.skills ? <li><strong>{adoptedSkills}</strong><span>个技能</span></li> : null}
        </ul> : null}
        {!state.available ? <p className="tp-ai-memory-notice" role="status">管理员尚未开启记忆功能：AI 暂不会学习或使用这些内容。你仍可以查看和删除已有记忆。</p> : null}
        <label className={`tp-ai-memory-switch${state.learningEnabled && state.available ? " is-on" : ""}`}>
          <input type="checkbox" role="switch" checked={state.learningEnabled} disabled={busy || !state.available}
            onChange={event => { const next = event.target.checked; void run(() => client.setLearning(next), next ? "已开启：AI 会继续记住你" : "已关闭：AI 不再学习，也不会参考这些记忆"); }} />
          <span className="tp-ai-memory-switch__track" aria-hidden="true"><span /></span>
          <span className="tp-ai-memory-switch__text"><strong>允许同频 AI 记住我</strong>
            <small>{state.learningEnabled ? "开启中：AI 会从对话中学习，并在回复时参考下面的内容。" : "已关闭：AI 不会学习新内容，也不会在回复时参考已保存的内容。"}</small></span>
        </label>
        {notice ? <p className={`tp-ai-memory-notice${notice.kind === "error" ? " is-error" : " is-success"}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}
        {(["user", "memory"] as const).map(target => {
          const store = state.stores[target];
          const percent = memoryUsagePercent(store.usedCharacters, store.limitCharacters);
          const headingId = `${titleId}-${target}`;
          const draftLength = memoryEntryLength(drafts[target]);
          return <section key={target} className="tp-ai-memory-store" aria-labelledby={headingId}>
            <header>
              <span><h3 id={headingId}>{AI_MEMORY_TARGET_LABELS[target]}</h3><small>{STORE_HINTS[target].hint}</small></span>
              <span className="tp-ai-memory-usage">{store.usedCharacters.toLocaleString("zh-CN")}/{store.limitCharacters.toLocaleString("zh-CN")} 字</span>
            </header>
            <div className={`tp-ai-memory-meter${percent >= 80 ? " is-high" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={store.limitCharacters} aria-valuenow={store.usedCharacters}
              aria-label={`${AI_MEMORY_TARGET_LABELS[target]}已用 ${percent}%`}><span style={{ width: `${percent}%` }} /></div>
            {store.entries.length ? <ul className="tp-ai-memory-entries">
              {store.entries.map((entry, index) => editing?.target === target && editing.index === index
                ? <li key={`${index}-${entry}`} className="is-editing">
                  <textarea aria-label="编辑这条记忆" value={editing.text} maxLength={AI_MEMORY_LIMITS.entryCharacters * 2} autoFocus disabled={busy}
                    onChange={event => setEditing({ ...editing, text: event.target.value })} />
                  <span className="tp-ai-memory-entry__actions">
                    <small className={memoryEntryLength(editing.text) > AI_MEMORY_LIMITS.entryCharacters ? "is-over" : undefined}>{memoryEntryLength(editing.text)}/{AI_MEMORY_LIMITS.entryCharacters}</small>
                    <button type="button" className="tp-ai-memory-button" disabled={busy || memoryEntryLength(editing.text) > AI_MEMORY_LIMITS.entryCharacters} onClick={() => void saveEdit()}><Check size={14} aria-hidden="true" />保存</button>
                    <button type="button" className="tp-ai-memory-button is-quiet" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                  </span>
                </li>
                : <li key={`${index}-${entry}`}>
                  <p>{entry}</p>
                  <span className="tp-ai-memory-entry__actions">
                    <button type="button" className="tp-ai-memory-icon" aria-label={`编辑：${entry}`} title="编辑" disabled={busy || !state.available} onClick={() => setEditing({ target, index, original: entry, text: entry })}><Pencil size={14} /></button>
                    <button type="button" className="tp-ai-memory-icon is-danger" aria-label={`删除：${entry}`} title="删除" disabled={busy}
                      onClick={() => void update({ action: "remove", target, index, expectedEntry: entry }, "已删除")}><Trash2 size={14} /></button>
                  </span>
                </li>)}
            </ul> : <p className="tp-ai-memory-empty">{STORE_HINTS[target].empty}</p>}
            {state.available ? <form className="tp-ai-memory-add" onSubmit={event => void addEntry(event, target)}>
              <input aria-label={`添加到「${AI_MEMORY_TARGET_LABELS[target]}」`} placeholder={STORE_HINTS[target].placeholder} value={drafts[target]} disabled={busy}
                maxLength={AI_MEMORY_LIMITS.entryCharacters * 2} onChange={event => setDrafts(current => ({ ...current, [target]: event.target.value }))} />
              <button type="submit" className="tp-ai-memory-button" disabled={busy || !draftLength || draftLength > AI_MEMORY_LIMITS.entryCharacters}><Plus size={14} aria-hidden="true" />添加</button>
            </form> : null}
          </section>;
        })}
        {state.recall ? <MemberRecallSection recall={state.recall} /> : null}
        {state.skills ? <MemberSkillsSection skills={state.skills} busy={busy} onUpdate={updateSkill} /> : null}
        <footer className="tp-ai-memory-footer">
          {confirmClear
            ? <><span>清空后，两类记忆、回忆记录和 AI 学到的技能都会删除且无法恢复；现有对话仍保留，但不会再被回忆（之后的新对话照常可以回忆）。专属 AI 设置不受影响。</span>
              <button type="button" className="tp-ai-memory-button is-danger" disabled={busy} onClick={() => void run(() => client.clear(), "已清空全部记忆").then(() => setConfirmClear(false))}>确认清空</button>
              <button type="button" className="tp-ai-memory-button is-quiet" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button></>
            : <button type="button" className="tp-ai-memory-button is-danger-outline" disabled={busy || learned === 0} onClick={() => setConfirmClear(true)}><Trash2 size={14} aria-hidden="true" />清空全部记忆</button>}
        </footer>
        <p className="tp-ai-usage-dialog__notice tp-ai-memory-privacy"><ShieldCheck size={15} aria-hidden="true" />
          <span>只有你本人能查看和修改这些内容，管理员和老板无法查看；回忆只会搜索你自己的对话。密码、验证码、证件号和银行卡号不会被记住。
            {state.pricePoints > 0 ? ` AI 更新记忆或提议技能时，每次按管理员设定扣除 ${formatAiPoints(state.pricePoints)}，没有更新不扣点。` : " 整理记忆和提议技能不额外扣除同频点。"}
            {state.recall?.enabled ? " 回忆到的片段会作为本次对话的输入，计入正常用量。" : ""}</span></p>
        <p className="tp-ai-memory-footnote"><Info size={13} aria-hidden="true" />新学到的记忆会在下一次新对话中生效；技能在你采纳后生效；你在这里做的修改会立即生效。</p>
      </div>}
    </section>
  </div>, host);
}
