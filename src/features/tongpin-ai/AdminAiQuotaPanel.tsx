import { Coins, History, Plus, RefreshCw, Search, UsersRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AiMember, AiUsageEntry } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { AdminAiProviderSettings } from "./AdminAiProviderSettings";
import { adminAiErrorMessage, calculateAiQuotaLimit, formatAiTokens } from "./adminAiForms";
import { aiUsageDescription, aiUsageTotal } from "./usageFormatting";
import "./AdminAiQuotaPanel.css";

const MEMBER_STATUS: Record<string, string> = {
  active: "已启用", disabled: "已停用", pending_email: "待验证邮箱", pending_approval: "待审核",
};
const USAGE_STATUS: Record<AiUsageEntry["status"], string> = {
  completed: "已完成", failed: "失败", uncertain: "待核对", adjusted: "额度调整",
};

export function AdminAiMemberIdentity({ member }: { member: Pick<AiMember, "name" | "email" | "role"> }) {
  return <>
    <span className="tp-ai-admin-member-name"><strong>{member.name}</strong>
      {member.role === "boss" ? <span className="tp-ai-admin-member-role">老板</span> : null}
    </span>
    <small>{member.email}</small>
  </>;
}

function AdminAiDialog({ title, children, busy = false, onClose }: {
  title: string; children: ReactNode; busy?: boolean; onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); previousFocus?.focus(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="tp-ai-admin-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="tp-ai-admin-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="tp-ai-admin-button is-icon" type="button" aria-label="关闭弹窗" disabled={busy} onClick={onClose}><X size={20} /></button>
      </header>
      {children}
    </dialog>
  );
}

function MemberQuotaDialog({ member, onClose, onSaved }: {
  member: AiMember; onClose: () => void; onSaved: (member: AiMember) => void;
}) {
  const { api } = useAuth();
  const id = useId();
  const [mode, setMode] = useState<"set" | "add">("set");
  const [amount, setAmount] = useState(String(member.quota.limitTokens));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const next = calculateAiQuotaLimit(amount, mode, member.quota);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (next.error) { setError(next.error); return; }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ member: AiMember }>(`/api/admin/ai/members/${encodeURIComponent(member.id)}/quota`, {
        method: "PUT",
        body: JSON.stringify({ limitTokens: next.limitTokens, reason: reason.trim() || (mode === "add" ? "管理员追加额度" : "管理员设置总限额") }),
      });
      onSaved(result.member);
    } catch (caught) {
      setError(adminAiErrorMessage(caught, "额度保存失败，请刷新成员列表后重试。"));
    } finally { busyRef.current = false; setBusy(false); }
  }

  return (
    <AdminAiDialog title={`设置额度 · ${member.name}`} onClose={onClose} busy={busy}>
      <p className="tp-ai-admin-hint">{member.email}</p>
      <div className="tp-ai-admin-quota-preview">
        <span>当前总限额<strong>{formatAiTokens(member.quota.limitTokens)}</strong></span>
        <span>已使用<strong>{formatAiTokens(member.quota.usedTokens)}</strong></span>
        <span>正在使用<strong>{formatAiTokens(member.quota.reservedTokens)}</strong></span>
      </div>
      <form onSubmit={submit}>
        <fieldset className="tp-ai-admin-fields" disabled={busy}>
          <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-mode`}>调整方式
            <select id={`${id}-mode`} value={mode} onChange={(event) => {
              const nextMode = event.target.value as "set" | "add";
              setMode(nextMode); setAmount(nextMode === "set" ? String(member.quota.limitTokens) : ""); setError("");
            }}>
              <option value="set">设置总限额</option><option value="add">追加额度</option>
            </select>
          </label>
          <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-amount`}>
            {mode === "set" ? "总限额" : "追加数量"} · 额度
            <input id={`${id}-amount`} type="text" inputMode="numeric" autoFocus required value={amount}
              maxLength={10} placeholder="填写整数" onChange={(event) => { setAmount(event.target.value); setError(""); }}
              aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
          </label>
          <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-reason`}>备注（选填）
            <input id={`${id}-reason`} value={reason} maxLength={200} placeholder="例如：本次客户提案" onChange={(event) => setReason(event.target.value)} />
          </label>
        </fieldset>
        {amount && !next.error ? <p className="tp-ai-admin-hint">保存后总限额为 {formatAiTokens(next.limitTokens)}，剩余 {formatAiTokens(next.limitTokens - member.quota.usedTokens - member.quota.reservedTokens)} 额度。</p> : null}
        {error ? <p id={`${id}-error`} className="tp-ai-admin-error" role="alert">{error}</p> : null}
        <footer className="tp-ai-admin-actions is-end">
          <button className="tp-ai-admin-button" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="tp-ai-admin-button is-primary" type="submit" disabled={busy || !amount || (!next.error && next.limitTokens === member.quota.limitTokens)}>
            <Plus size={17} aria-hidden="true" />{busy ? "保存中…" : "确认保存"}
          </button>
        </footer>
      </form>
    </AdminAiDialog>
  );
}

function MemberUsageDialog({ member, onClose }: { member: AiMember; onClose: () => void }) {
  const { api } = useAuth();
  const [entries, setEntries] = useState<AiUsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api<{ entries: AiUsageEntry[] }>(`/api/admin/ai/usage?userId=${encodeURIComponent(member.id)}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setEntries(result.entries); })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(adminAiErrorMessage(caught, "使用记录读取失败，请重试。")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, member.id, version]);
  return (
    <AdminAiDialog title={`Token 明细 · ${member.name}`} onClose={onClose}>
      <p className="tp-ai-admin-hint">{member.email}</p>
      {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
      {loading ? <p role="status">正在读取使用记录…</p> : !error && entries.length === 0 ? <p className="tp-ai-admin-empty">暂无使用记录</p> : !error ? (
        <div className="tp-ai-admin-usage-list">
          {entries.map((entry) => (
            <article className="tp-ai-admin-usage-entry" key={entry.id}>
              <header><strong>{entry.kind === "quota" ? "额度调整" : entry.model || "AI 对话"}</strong>
                <span className={`tp-ai-admin-status ${entry.status === "completed" ? "is-active" : ""}`}>{USAGE_STATUS[entry.status]}</span></header>
              {entry.kind === "quota" ? <p>总限额 {formatAiTokens(entry.limitTokens ?? 0)} 额度{entry.reason ? ` · ${entry.reason}` : ""}</p>
                : <p>{aiUsageDescription(entry)} · 合计 {aiUsageTotal(entry)}</p>}
              <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time>
            </article>
          ))}
        </div>
      ) : null}
      <footer className="tp-ai-admin-actions is-end">
        {error ? <button className="tp-ai-admin-button" type="button" onClick={() => setVersion((value) => value + 1)}>重新加载</button> : null}
        <button className="tp-ai-admin-button" type="button" onClick={onClose}>关闭</button>
      </footer>
    </AdminAiDialog>
  );
}

export function AdminAiQuotaPanel() {
  const { api, session } = useAuth();
  const isAdmin = session?.user.role === "admin";
  const [members, setMembers] = useState<AiMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [quotaMember, setQuotaMember] = useState<AiMember | null>(null);
  const [usageMember, setUsageMember] = useState<AiMember | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    api<{ members: AiMember[] }>("/api/admin/ai/members", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setMembers(result.members); })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(adminAiErrorMessage(caught, "成员额度读取失败，请重试。")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, isAdmin, version]);

  if (!isAdmin) return <p role="alert">仅管理员可访问 AI 管理。</p>;
  const needle = query.trim().toLocaleLowerCase();
  const visibleMembers = members.filter((member) => `${member.name} ${member.email}`.toLocaleLowerCase().includes(needle));

  return (
    <section className="tp-admin-ai-quota" aria-label="AI 接入与额度管理">
      <AdminAiProviderSettings />
      <section className="tp-ai-admin-card" aria-labelledby="tp-ai-admin-members-title" aria-busy={loading}>
        <header className="tp-ai-admin-heading">
          <div><h2 id="tp-ai-admin-members-title"><UsersRound size={21} aria-hidden="true" />成员额度</h2>
            <p>文本每个 Token 扣 1 额度，图片与搜索按设置折算；默认 0，用尽后仅管理员可追加。</p></div>
          <button className="tp-ai-admin-button" type="button" disabled={loading} onClick={() => { setNotice(""); setVersion((value) => value + 1); }}>
            <RefreshCw size={17} aria-hidden="true" />刷新
          </button>
        </header>
        <label className="tp-ai-admin-search"><Search size={18} aria-hidden="true" />
          <input type="search" aria-label="搜索成员姓名或邮箱" placeholder="搜索姓名或邮箱" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
        {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
        {loading ? <p className="tp-ai-admin-empty" role="status">正在读取成员额度…</p> : error ? null : visibleMembers.length === 0 ? (
          <p className="tp-ai-admin-empty">{query ? "没有找到匹配的成员" : "暂无成员，请先在账号管理中添加成员。"}</p>
        ) : (
          <div className="tp-ai-admin-table-scroll" tabIndex={0} aria-label="成员额度表格，可横向滚动">
            <table className="tp-ai-admin-table">
              <thead><tr><th>成员</th><th>账号状态</th><th>总限额</th><th>已使用</th><th>正在使用</th><th>剩余额度</th><th>操作</th></tr></thead>
              <tbody>{visibleMembers.map((member) => (
                <tr key={member.id}>
                  <td><AdminAiMemberIdentity member={member} /></td>
                  <td><span className={`tp-ai-admin-status ${member.status === "active" ? "is-active" : ""}`}>{MEMBER_STATUS[member.status] ?? "不可用"}</span></td>
                  <td>{formatAiTokens(member.quota.limitTokens)}</td><td>{formatAiTokens(member.quota.usedTokens)}</td>
                  <td>{formatAiTokens(member.quota.reservedTokens)}</td><td><strong>{formatAiTokens(member.quota.remainingTokens)}</strong></td>
                  <td><div className="tp-ai-admin-row-actions">
                    <button className="tp-ai-admin-button is-primary" type="button" aria-label={`设置 ${member.name} 的额度`} onClick={() => setQuotaMember(member)}><Coins size={16} aria-hidden="true" />设额度</button>
                    <button className="tp-ai-admin-button" type="button" aria-label={`查看 ${member.name} 的 Token 明细`} onClick={() => setUsageMember(member)}><History size={16} aria-hidden="true" />明细</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {quotaMember ? <MemberQuotaDialog member={quotaMember} onClose={() => setQuotaMember(null)} onSaved={(member) => {
        setMembers((current) => current.map((item) => item.id === member.id ? member : item));
        setQuotaMember(null); setNotice(`${member.name} 的总限额已保存为 ${formatAiTokens(member.quota.limitTokens)} 额度。`);
      }} /> : null}
      {usageMember ? <MemberUsageDialog member={usageMember} onClose={() => setUsageMember(null)} /> : null}
    </section>
  );
}
