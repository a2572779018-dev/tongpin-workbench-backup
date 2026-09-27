import { Check, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { AI_MEMORY_SKILL_LIMITS, type AiMemorySkill, type AiMemorySkillOperation, type AiMemorySkillsView } from "../../../shared/aiMemoryLearning";
import { skillDraft, skillInput, skillUsageLabel } from "./memberLearningClient";

type Draft = ReturnType<typeof skillDraft>;
type Editing = { id: string | null; draft: Draft };

const REASON_LABELS: Record<NonNullable<AiMemorySkill["reason"]>, (evidence?: number) => string> = {
  repeated: evidence => `你已提过 ${evidence ?? 3} 次类似的请求`,
  multi_step: () => "来自一次多步骤的任务",
  explicit: () => "你要求以后按固定方式做",
};

function SkillEditor({ editing, busy, submitLabel, onChange, onSubmit, onCancel }: {
  editing: Editing; busy: boolean; submitLabel: string;
  onChange: (draft: Draft) => void; onSubmit: () => void; onCancel: () => void;
}) {
  const id = useId();
  const { draft } = editing;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onSubmit(); };
  return <form className="tp-ai-skill-editor" onSubmit={submit} aria-label="编辑技能">
    <label htmlFor={`${id}-name`}>名称<input id={`${id}-name`} value={draft.name} maxLength={AI_MEMORY_SKILL_LIMITS.nameCharacters * 2} placeholder="例如：周报格式" disabled={busy} autoFocus
      onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
    <label htmlFor={`${id}-when`}>什么时候用<input id={`${id}-when`} value={draft.whenToUse} maxLength={AI_MEMORY_SKILL_LIMITS.whenToUseCharacters * 2} placeholder="例如：写每周工作汇报时" disabled={busy}
      onChange={event => onChange({ ...draft, whenToUse: event.target.value })} /></label>
    <label htmlFor={`${id}-steps`}>怎么做（格式、步骤、偏好）<textarea id={`${id}-steps`} value={draft.instructions} maxLength={AI_MEMORY_SKILL_LIMITS.instructionsCharacters * 2} disabled={busy}
      placeholder={"例如：\n1. 先写本周结论\n2. 列出完成事项和关键数据\n3. 写风险和下周计划"} onChange={event => onChange({ ...draft, instructions: event.target.value })} /></label>
    <label htmlFor={`${id}-triggers`}>触发词<input id={`${id}-triggers`} value={draft.triggers} placeholder="用顿号或逗号分隔，例如：周报、每周汇报" disabled={busy}
      onChange={event => onChange({ ...draft, triggers: event.target.value })} /></label>
    <span className="tp-ai-memory-entry__actions">
      <small>{Array.from(draft.instructions.trim()).length}/{AI_MEMORY_SKILL_LIMITS.instructionsCharacters}</small>
      <button type="submit" className="tp-ai-memory-button" disabled={busy}><Check size={14} aria-hidden="true" />{submitLabel}</button>
      <button type="button" className="tp-ai-memory-button is-quiet" disabled={busy} onClick={onCancel}>取消</button>
    </span>
  </form>;
}

function SkillBody({ skill }: { skill: AiMemorySkill }) {
  return <>
    <p className="tp-ai-skill__when">{skill.whenToUse}</p>
    <p className="tp-ai-skill__steps">{skill.instructions}</p>
    <p className="tp-ai-skill__triggers" aria-label="触发词">{skill.triggers.map(trigger => <span key={trigger}>{trigger}</span>)}</p>
  </>;
}

/**
 * 「AI 学到的技能」: proposals from the background review wait for the
 * member (采纳 / 编辑 / 忽略); adopted skills apply automatically to matching
 * requests or through @, and can be edited or deleted at any time.
 */
export function MemberSkillsSection({ skills, busy, onUpdate }: {
  skills: AiMemorySkillsView;
  busy: boolean;
  onUpdate: (operation: AiMemorySkillOperation, success: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const proposals = skills.items.filter(skill => skill.status === "proposed");
  const adopted = skills.items.filter(skill => skill.status === "adopted");
  const nameOf = (id: string | undefined) => adopted.find(skill => skill.id === id)?.name;

  async function save(skill: AiMemorySkill | null) {
    if (!editing) return;
    const input = skillInput(editing.draft);
    const ok = !skill
      ? await onUpdate({ action: "create", skill: input }, "已添加技能")
      : skill.status === "proposed"
        ? await onUpdate({ action: "adopt", id: skill.id, expectedRevision: skill.revision, skill: input }, "已采纳这个技能")
        : await onUpdate({ action: "update", id: skill.id, expectedRevision: skill.revision, skill: input }, "已更新技能");
    if (ok) setEditing(null);
  }
  const editor = (skill: AiMemorySkill | null) => editing && editing.id === (skill?.id ?? null)
    ? <SkillEditor editing={editing} busy={busy} submitLabel={skill?.status === "proposed" ? "保存并采纳" : "保存"}
      onChange={draft => setEditing({ ...editing, draft })} onSubmit={() => void save(skill)} onCancel={() => setEditing(null)} />
    : null;

  return <section className="tp-ai-memory-store tp-ai-skill-store" aria-labelledby={headingId}>
    <header>
      <span><h3 id={headingId}><Sparkles size={15} aria-hidden="true" />AI 学到的技能</h3><small>为你沉淀的做事方式：格式、步骤和偏好。采纳后，相关请求会自动照做，也可以在输入框用 @ 调用。</small></span>
      <span className="tp-ai-memory-usage">已采纳 {adopted.length}/{AI_MEMORY_SKILL_LIMITS.adopted}</span>
    </header>
    {!skills.enabled ? <p className="tp-ai-memory-empty">管理员未开启技能学习：AI 暂不会提议新技能，已采纳的技能也暂不生效。你仍可查看和删除。</p> : null}
    {proposals.length ? <div className="tp-ai-skill-group">
      <h4>待你确认 · {proposals.length}</h4>
      <ul className="tp-ai-memory-entries tp-ai-skill-list">
        {proposals.map(skill => <li key={skill.id} className="tp-ai-skill is-proposed">
          {editor(skill) ?? <>
            <div className="tp-ai-skill__head"><strong>{skill.name}</strong>{skill.replacesId ? <small>改进「{nameOf(skill.replacesId) ?? "已采纳的技能"}」</small> : null}
              {skill.reason ? <small className="tp-ai-skill__reason">{REASON_LABELS[skill.reason](skill.evidence)}</small> : null}</div>
            <SkillBody skill={skill} />
            <span className="tp-ai-memory-entry__actions">
              <button type="button" className="tp-ai-memory-button" disabled={busy || !skills.enabled} onClick={() => void onUpdate({ action: "adopt", id: skill.id, expectedRevision: skill.revision }, "已采纳这个技能")}>
                <Check size={14} aria-hidden="true" />采纳</button>
              <button type="button" className="tp-ai-memory-button is-quiet" disabled={busy || !skills.enabled} onClick={() => setEditing({ id: skill.id, draft: skillDraft(skill) })}><Pencil size={14} aria-hidden="true" />编辑</button>
              <button type="button" className="tp-ai-memory-button is-quiet" disabled={busy} onClick={() => void onUpdate({ action: "dismiss", id: skill.id, expectedRevision: skill.revision }, "已忽略，AI 不会再提议同类技能")}>
                <X size={14} aria-hidden="true" />忽略</button>
            </span>
          </>}
        </li>)}
      </ul>
    </div> : null}
    {adopted.length ? <div className="tp-ai-skill-group">
      {proposals.length ? <h4>已采纳</h4> : null}
      <ul className="tp-ai-memory-entries tp-ai-skill-list">
        {adopted.map(skill => <li key={skill.id} className={`tp-ai-skill${skill.stale ? " is-stale" : ""}`}>
          {editor(skill) ?? <>
            <div className="tp-ai-skill__head"><strong>{skill.name}</strong><code>@{skill.id}</code></div>
            <SkillBody skill={skill} />
            <span className="tp-ai-memory-entry__actions">
              <small className={skill.stale ? "is-over" : undefined}>{skillUsageLabel(skill)}</small>
              <button type="button" className="tp-ai-memory-icon" aria-label={`编辑技能：${skill.name}`} title="编辑" disabled={busy || !skills.enabled} onClick={() => setEditing({ id: skill.id, draft: skillDraft(skill) })}><Pencil size={14} /></button>
              <button type="button" className="tp-ai-memory-icon is-danger" aria-label={`删除技能：${skill.name}`} title="删除" disabled={busy}
                onClick={() => void onUpdate({ action: "delete", id: skill.id, expectedRevision: skill.revision }, "已删除技能")}><Trash2 size={14} /></button>
            </span>
          </>}
        </li>)}
      </ul>
    </div> : !proposals.length ? <p className="tp-ai-memory-empty">还没有技能。当你多次让 AI 做同一类事情（比如同样格式的周报），AI 会在这里提议一个技能，由你决定是否采纳。</p> : null}
    {editor(null)}
    {skills.enabled && !editing && adopted.length < AI_MEMORY_SKILL_LIMITS.adopted
      ? <button type="button" className="tp-ai-memory-button is-quiet tp-ai-skill-add" disabled={busy} onClick={() => setEditing({ id: null, draft: skillDraft() })}><Plus size={14} aria-hidden="true" />自己添加一个技能</button>
      : null}
  </section>;
}
