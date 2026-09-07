import { ArrowLeft, ArrowUp, Check, Heart, Lightbulb, SlidersHorizontal, Sparkles, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AiPersonaProfile, AiPersonaSnapshot } from "../../../shared/aiPersona";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";

const PERSONALITIES = [
  { id: "warm", name: "温暖搭档", description: "亲切耐心，一起把事情想清楚", Icon: Heart },
  { id: "professional", name: "专业顾问", description: "条理清晰，重视依据与可执行性", Icon: SlidersHorizontal },
  { id: "concise", name: "高效行动派", description: "先给结论，少说废话", Icon: Zap },
  { id: "creative", name: "创意伙伴", description: "善于发散，带来不同角度", Icon: Lightbulb },
] as const;

export function PersonaSetup({ snapshot, accountId, onSaved, onClose }: {
  snapshot: AiPersonaSnapshot;
  accountId: string;
  onSaved: (snapshot: AiPersonaSnapshot) => void;
  onClose?: () => void;
}) {
  const { api } = useAuth();
  const editing = snapshot.profile.onboardingComplete;
  const [step, setStep] = useState(editing ? 2 : 0);
  const [profile, setProfile] = useState<AiPersonaProfile>(snapshot.profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [resetConfirm, setResetConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const name = profile.name.trim() || "同频 AI";
  useEffect(() => {
    aliveRef.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && editing && !busyRef.current) { event.preventDefault(); closeRef.current?.(); }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[href]') ?? []).filter(item => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { aliveRef.current = false; document.removeEventListener("keydown", onKey); previous?.isConnected && previous.focus(); };
  }, [editing]);

  async function save(reset = false) {
    if (busyRef.current) return;
    if (!reset && (!profile.name.trim() || profile.name.trim().length > 40)) { setError("请为我取一个 1 到 40 字的名字"); return; }
    busyRef.current = true; setSaving(true); setError(""); setConflict(false);
    try {
      const next = await api<AiPersonaSnapshot>("/api/ai/persona", {
        method: "PUT", headers: { "X-Tongpin-Account": accountId },
        body: JSON.stringify(reset ? { expectedRevision: snapshot.revision, reset: true } : {
          expectedRevision: snapshot.revision, profile: { ...profile, name: profile.name.trim(), customStyle: profile.customStyle.trim(), preferences: profile.preferences.trim(), onboardingComplete: true },
        }),
      });
      if (aliveRef.current) onSaved(next);
    } catch (caught) { if (aliveRef.current) { setError(caught instanceof Error ? caught.message : "暂时无法保存，请重试"); setConflict(caught instanceof ApiRequestError && caught.code === "AI_PERSONA_CONFLICT"); } }
    finally { busyRef.current = false; if (aliveRef.current) setSaving(false); }
  }
  async function reloadSaved() {
    if (busyRef.current) return;
    busyRef.current = true; setSaving(true);
    try {
      const next = await api<AiPersonaSnapshot>("/api/ai/persona", { headers: { "X-Tongpin-Account": accountId } });
      if (aliveRef.current) onSaved(next);
    } catch (caught) { if (aliveRef.current) setError(caught instanceof Error ? caught.message : "读取失败，请重试"); }
    finally { busyRef.current = false; if (aliveRef.current) setSaving(false); }
  }
  function nextStep(event: FormEvent) {
    event.preventDefault();
    if (step === 0 && !profile.name.trim()) { inputRef.current?.focus(); return; }
    if (step < 2) { setStep(value => value + 1); setError(""); }
    else void save();
  }

  return <div className="tp-ai-persona-layer">
    <section ref={dialogRef} className="tp-ai-persona-dialog" role="dialog" aria-modal="true" aria-labelledby="tp-ai-persona-title">
      <header><span className="tp-ai-persona-symbol"><Sparkles size={23} /></span>
        <div><h2 id="tp-ai-persona-title">{editing ? "我的专属 AI" : "认识你的专属 AI"}</h2><small>{editing ? "已保存的名字、性格与偏好" : `${step + 1} / 3 · ${["取个名字", "选择性格", "确认偏好"][step]}`}</small></div>
        {editing && <button type="button" aria-label="关闭专属 AI 设置" disabled={saving} onClick={onClose}><X size={19} /></button>}
      </header>
      <div className="tp-ai-persona-dialog__body">
        <div className="tp-ai-persona-message" aria-live="polite"><strong>{step === 0 ? "同频 AI" : name}</strong>
          <p>{editing ? "你可以随时修改我的名字和相处方式。下次对话，我会按照新的设置与你合作。"
            : step === 0 ? "你好，我是同频 AI，你的专属工作伙伴。你希望我叫什么名字？"
            : step === 1 ? `${name}，这个名字不错。你希望我以什么样的性格和你相处？选一个，也可以告诉我你的想法。`
            : "还有哪些习惯希望我记住？比如默认用中文、先给结论、方案最好带执行步骤。确认后，我会在以后的对话中沿用。"}</p>
        </div>
        <form onSubmit={nextStep}>
          {(step === 0 || editing) && <label className="tp-ai-persona-field">AI 的名字
            <input ref={inputRef} value={profile.name} maxLength={40} placeholder="例如：小频" disabled={saving}
              onChange={event => setProfile(current => ({ ...current, name: event.target.value }))}
              onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
          </label>}
          {(step === 1 || editing) && <>
            <div className="tp-ai-personalities" role="group" aria-label="选择 AI 性格">
              {PERSONALITIES.map(({ id, name: title, description, Icon }) => <button type="button" key={id} disabled={saving}
                className={profile.tone === id ? "is-selected" : ""} aria-pressed={profile.tone === id}
                onClick={() => setProfile(current => ({ ...current, tone: id }))}>
                <Icon size={20} /><strong>{title}</strong><small>{description}</small>{profile.tone === id && <Check size={14} className="tp-ai-personality-check" />}
              </button>)}
            </div>
            <label className="tp-ai-persona-field">也可以用自己的话告诉我
              <textarea value={profile.customStyle} maxLength={2000} rows={3} disabled={saving} placeholder="比如：幽默一点，但讨论工作时认真直接。"
                onChange={event => setProfile(current => ({ ...current, customStyle: event.target.value }))} />
            </label>
          </>}
          {step === 2 && <label className="tp-ai-persona-field">希望我长期记住的偏好（可留空）
            <textarea value={profile.preferences} maxLength={4000} rows={4} disabled={saving} placeholder="例如：称呼我 Sam；回答用简体中文；先给简短结论。不要填写密码或 API 密钥。"
              onChange={event => setProfile(current => ({ ...current, preferences: event.target.value }))} />
          </label>}
          {step === 2 && <p className="tp-ai-persona-memory-note">只保存你在这里确认的内容，随账号同步；可随时修改或清除。</p>}
          {step === 2 && !editing && <div className="tp-ai-persona-summary"><span>名字：{name}</span><span>性格：{PERSONALITIES.find(item => item.id === profile.tone)?.name}</span>
            {profile.customStyle && <p>{profile.customStyle}</p>}
          </div>}
          {error && <p className="tp-ai-persona-error" role="alert">{error}</p>}
          {conflict && <button type="button" disabled={saving} onClick={() => void reloadSaved()}>放弃本次修改，载入已保存设置</button>}
          <footer>
            {!editing && step > 0 ? <button type="button" disabled={saving} onClick={() => setStep(value => value - 1)}><ArrowLeft size={16} />上一步</button> : <span />}
            <button type="submit" className="is-primary" disabled={saving || (step === 0 && !profile.name.trim())}>
              {saving ? "正在记住…" : step < 2 ? "发送" : editing ? "保存记忆" : "确认，开始对话"}{step < 2 ? <ArrowUp size={16} /> : <Check size={16} />}
            </button>
          </footer>
        </form>
        {editing && <div className="tp-ai-persona-reset">
          {resetConfirm ? <><p>清除名字、性格和偏好，重新认识我？聊天和项目不会删除。</p><button type="button" disabled={saving} onClick={() => void save(true)}>确认清除记忆</button><button type="button" disabled={saving} onClick={() => setResetConfirm(false)}>取消</button></>
            : <button type="button" disabled={saving} onClick={() => setResetConfirm(true)}>清除这些记忆并重新设置</button>}
        </div>}
      </div>
    </section>
  </div>;
}
