import { useId, useState } from "react";
import { ArrowsLeftRight, FloppyDisk, X } from "@phosphor-icons/react";
import {
  buildConnectionRecord,
  connectionRecord,
  relationPersonOptionLabel,
  RELATIONSHIP_LIMITS,
  RELATIONSHIP_PRESETS,
  validateConnectionDraft,
} from "../data/relationshipModel.js";

function describedBy(field, errors, hintId) {
  return errors[field] ? `${field}-error ${hintId || ""}`.trim() : hintId;
}

export function RelationModal({ mode, initialConnection, initialSource, people, connections, editingIndex, privacy = false, onClose, onSave }) {
  const titleId = useId();
  const descriptionId = useId();
  const strengthHintId = useId();
  const initial = initialConnection ? connectionRecord(initialConnection) : null;
  const [source, setSource] = useState(initial?.source || initialSource || "self");
  const [target, setTarget] = useState(initial?.target || "");
  const [relationship, setRelationship] = useState(initial?.relationship || "朋友");
  const [strength, setStrength] = useState(
    Number.isFinite(initial?.strength) ? String(Math.round(initial.strength * 100)) : "",
  );
  const [note, setNote] = useState(initial?.note || "");
  const [errors, setErrors] = useState({});

  const updateField = (field, setter) => (event) => {
    setter(event.target.value);
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const submit = (event) => {
    event.preventDefault();
    const strengthNumber = strength.trim() === "" ? undefined : Number(strength) / 100;
    const draft = { source, target, relationship, strength: strengthNumber, note };
    const nextErrors = validateConnectionDraft(draft, people, connections, editingIndex);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSave(buildConnectionRecord(draft));
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="relation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="relation-dialog__header">
          <div className="report-title-wrap">
            <span className="report-icon"><ArrowsLeftRight size={24} weight="duotone" /></span>
            <div>
              <p>{mode === "edit" ? "更新连接" : "补充图谱"}</p>
              <h2 id={titleId}>{mode === "edit" ? "编辑关系" : "新增关系"}</h2>
            </div>
          </div>
          <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭关系表单">
            <X size={18} weight="bold" />
          </button>
        </header>

        <p id={descriptionId} className="relation-dialog__description">
          选择两个不同的人物，关系类型可从建议中选择，也可直接填写。
        </p>

        <form className="relation-form" onSubmit={submit} noValidate>
          <div className="relation-form__pair">
            <div className="form-field">
              <label htmlFor="relation-source">起点人物 <span aria-hidden="true">*</span></label>
              <select
                id="relation-source"
                value={source}
                onChange={updateField("source", setSource)}
                aria-invalid={Boolean(errors.source)}
                aria-describedby={describedBy("source", errors)}
                autoFocus
              >
                <option value="">请选择</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id} disabled={person.id === target}>
                    {relationPersonOptionLabel(person, privacy)}
                  </option>
                ))}
              </select>
              {errors.source ? <span id="source-error" className="field-error" role="alert">{errors.source}</span> : null}
            </div>

            <span className="relation-pair-arrow" aria-hidden="true"><ArrowsLeftRight size={20} weight="bold" /></span>

            <div className="form-field">
              <label htmlFor="relation-target">终点人物 <span aria-hidden="true">*</span></label>
              <select
                id="relation-target"
                value={target}
                onChange={updateField("target", setTarget)}
                aria-invalid={Boolean(errors.target)}
                aria-describedby={describedBy("target", errors)}
              >
                <option value="">请选择</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id} disabled={person.id === source}>
                    {relationPersonOptionLabel(person, privacy)}
                  </option>
                ))}
              </select>
              {errors.target ? <span id="target-error" className="field-error" role="alert">{errors.target}</span> : null}
            </div>
          </div>

          <div className="relation-form__details">
            <div className="form-field">
              <label htmlFor="relation-type">关系类型 <span aria-hidden="true">*</span></label>
              <input
                id="relation-type"
                type="text"
                list="relationship-presets"
                maxLength={RELATIONSHIP_LIMITS.type + 1}
                value={relationship}
                onChange={updateField("relationship", setRelationship)}
                placeholder="例如：朋友、导师、合作伙伴"
                aria-invalid={Boolean(errors.relationship)}
                aria-describedby={describedBy("relationship", errors)}
              />
              <datalist id="relationship-presets">
                {RELATIONSHIP_PRESETS.map((type) => <option key={type} value={type} />)}
              </datalist>
              {errors.relationship ? <span id="relationship-error" className="field-error" role="alert">{errors.relationship}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="relation-strength">关系强度 <span className="label-optional">可选</span></label>
              <div className="strength-input-wrap">
                <input
                  id="relation-strength"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100"
                  step="1"
                  value={strength}
                  onChange={updateField("strength", setStrength)}
                  placeholder="65"
                  aria-invalid={Boolean(errors.strength)}
                  aria-describedby={describedBy("strength", errors, strengthHintId)}
                />
                <span aria-hidden="true">%</span>
              </div>
              <span id={strengthHintId} className="field-hint">留空则使用默认线条强度</span>
              {errors.strength ? <span id="strength-error" className="field-error" role="alert">{errors.strength}</span> : null}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="relation-note">关系备注 <span className="label-optional">可选</span></label>
            <textarea
              id="relation-note"
              rows="3"
              maxLength={RELATIONSHIP_LIMITS.note + 1}
              value={note}
              onChange={updateField("note", setNote)}
              placeholder="记录这段关系的背景或需要跟进的事项"
              aria-invalid={Boolean(errors.note)}
              aria-describedby={describedBy("note", errors)}
            />
            <span className="field-counter">{note.length}/{RELATIONSHIP_LIMITS.note}</span>
            {errors.note ? <span id="note-error" className="field-error" role="alert">{errors.note}</span> : null}
          </div>

          <div className="relation-form__actions">
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit">
              <FloppyDisk size={18} weight="bold" />{mode === "edit" ? "保存修改" : "保存关系"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
