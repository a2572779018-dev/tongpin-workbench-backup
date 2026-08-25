import { useId, useRef, useState } from "react";
import { FloppyDisk, ImageSquare, Trash, UserPlus, X } from "@phosphor-icons/react";
import { RELATIONSHIP_PRESETS } from "../data/relationshipModel.js";
import { PERSON_LIMITS, validatePersonDraft } from "../data/personModel.js";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const SAFE_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const personLevels = [
  { value: "core", label: "核心圈" },
  { value: "close", label: "常联系" },
  { value: "acquaintance", label: "偶尔联系" },
  { value: "weak", label: "弱联系" },
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("头像读取失败")), { once: true });
    reader.readAsDataURL(file);
  });
}

export function PersonModal({ mode, person, onClose, onSave }) {
  const titleId = useId();
  const descriptionId = useId();
  const fileInputRef = useRef(null);
  const isSelf = person?.id === "self";
  const [name, setName] = useState(person?.name || "");
  const [alias, setAlias] = useState(person?.alias || "");
  const [relationship, setRelationship] = useState(person?.relationship || "朋友");
  const [level, setLevel] = useState(person?.level === "self" ? "self" : person?.level || "acquaintance");
  const [community, setCommunity] = useState(person?.community || "");
  const [phone, setPhone] = useState(person?.phone || "");
  const [wechat, setWechat] = useState(person?.wechat || "");
  const [tags, setTags] = useState(person?.tags?.join("、") || "");
  const [note, setNote] = useState(person?.note || "");
  const [avatar, setAvatar] = useState(person?.avatar || null);
  const [avatarNotice, setAvatarNotice] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
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

  const chooseAvatar = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!SAFE_AVATAR_TYPES.has(file.type)) {
      setAvatar(null);
      setAvatarNotice("仅支持 PNG、JPEG、WebP 或 GIF，已回退为姓名首字。");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatar(null);
      setAvatarNotice("头像不能超过 2 MB，已回退为姓名首字。");
      return;
    }

    setAvatarBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (typeof dataUrl !== "string" || !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
        throw new Error("头像格式无效");
      }
      setAvatar(dataUrl);
      setAvatarNotice("头像已在本机转换，会随关系数据一同导出。");
    } catch {
      setAvatar(null);
      setAvatarNotice("头像读取失败，已回退为姓名首字。");
    } finally {
      setAvatarBusy(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    const draft = {
      name,
      alias,
      relationship: isSelf ? "自己" : relationship,
      level: isSelf ? "self" : level,
      community,
      phone,
      wechat,
      tags,
      note,
      avatar,
    };
    const nextErrors = validatePersonDraft(draft, { editingPerson: person || null });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSave(draft);
  };

  const initial = Array.from(name.trim())[0] || "人";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="person-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="relation-dialog__header">
          <div className="report-title-wrap">
            <span className="report-icon"><UserPlus size={24} weight="duotone" /></span>
            <div>
              <p>{mode === "edit" ? "更新人物资料" : "补充关系图谱"}</p>
              <h2 id={titleId}>{mode === "edit" ? "编辑人物" : "新增人物"}</h2>
            </div>
          </div>
          <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭人物表单">
            <X size={18} weight="bold" />
          </button>
        </header>

        <p id={descriptionId} className="relation-dialog__description">
          人物资料仅保存在当前关系图中，姓名和关系层级用于生成节点。
        </p>

        <form className="person-form" onSubmit={submit} noValidate>
          <div className="person-form__identity">
            <div className="avatar-field">
              <label htmlFor="person-avatar">人物头像 <span className="label-optional">可选</span></label>
              <div className="avatar-editor">
                <span className="avatar-editor__preview" aria-hidden="true">
                  {avatar ? (
                    <img
                      src={avatar}
                      alt=""
                      onError={() => {
                        setAvatar(null);
                        setAvatarNotice("头像加载失败，已回退为姓名首字。");
                      }}
                    />
                  ) : initial}
                </span>
                <div>
                  <input
                    ref={fileInputRef}
                    id="person-avatar"
                    className="visually-hidden"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    tabIndex={-1}
                    onChange={chooseAvatar}
                  />
                  <button className="secondary-button avatar-upload-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={avatarBusy}>
                    <ImageSquare size={17} weight="duotone" />{avatarBusy ? "读取中…" : avatar ? "更换头像" : "选择头像"}
                  </button>
                  {avatar ? (
                    <button
                      className="avatar-remove-button"
                      type="button"
                      onClick={() => {
                        setAvatar(null);
                        setAvatarNotice("已移除头像，将显示姓名首字。");
                      }}
                    >
                      <Trash size={14} weight="bold" />移除
                    </button>
                  ) : null}
                </div>
              </div>
              <span className="field-hint">PNG / JPEG / WebP / GIF，最大 2 MB。</span>
              {avatarNotice ? <span className="avatar-notice" role="status">{avatarNotice}</span> : null}
            </div>

            <div className="person-form__identity-fields">
              <div className="form-field">
                <label htmlFor="person-name">姓名 <span aria-hidden="true">*</span></label>
                <input
                  id="person-name"
                  value={name}
                  maxLength={PERSON_LIMITS.name + 1}
                  onChange={updateField("name", setName)}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "person-name-error" : undefined}
                  autoFocus
                />
                {errors.name ? <span id="person-name-error" className="field-error" role="alert">{errors.name}</span> : null}
              </div>

              <div className="form-field">
                <label htmlFor="person-alias">备注名 <span aria-hidden="true">*</span></label>
                <input
                  id="person-alias"
                  value={alias}
                  maxLength={PERSON_LIMITS.alias + 1}
                  onChange={updateField("alias", setAlias)}
                  placeholder="例如：大学同学"
                  aria-invalid={Boolean(errors.alias)}
                  aria-describedby={errors.alias ? "person-alias-error" : undefined}
                />
                {errors.alias ? <span id="person-alias-error" className="field-error" role="alert">{errors.alias}</span> : null}
              </div>
            </div>
          </div>

          <div className="person-form__grid">
            <div className="form-field">
              <label htmlFor="person-relationship">与你的关系 <span aria-hidden="true">*</span></label>
              <select
                id="person-relationship"
                value={isSelf ? "自己" : relationship}
                onChange={updateField("relationship", setRelationship)}
                disabled={isSelf}
                aria-invalid={Boolean(errors.relationship)}
                aria-describedby={errors.relationship ? "person-relationship-error" : undefined}
              >
                {isSelf ? <option value="自己">自己</option> : null}
                {RELATIONSHIP_PRESETS.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              {errors.relationship ? <span id="person-relationship-error" className="field-error" role="alert">{errors.relationship}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="person-level">关系层级 <span aria-hidden="true">*</span></label>
              <select
                id="person-level"
                value={isSelf ? "self" : level}
                onChange={updateField("level", setLevel)}
                disabled={isSelf}
                aria-invalid={Boolean(errors.level)}
                aria-describedby={errors.level ? "person-level-error" : undefined}
              >
                {isSelf ? <option value="self">关系中心</option> : null}
                {personLevels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {errors.level ? <span id="person-level-error" className="field-error" role="alert">{errors.level}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="person-community">所属圈层 <span aria-hidden="true">*</span></label>
              <input
                id="person-community"
                value={community}
                maxLength={PERSON_LIMITS.community + 1}
                onChange={updateField("community", setCommunity)}
                placeholder="例如：家庭、产品组"
                aria-invalid={Boolean(errors.community)}
                aria-describedby={errors.community ? "person-community-error" : undefined}
              />
              {errors.community ? <span id="person-community-error" className="field-error" role="alert">{errors.community}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="person-phone">手机号 <span className="label-optional">可选</span></label>
              <input
                id="person-phone"
                value={phone}
                maxLength={PERSON_LIMITS.phone + 1}
                onChange={updateField("phone", setPhone)}
                placeholder="仅保存在当前图谱"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? "person-phone-error" : undefined}
              />
              {errors.phone ? <span id="person-phone-error" className="field-error" role="alert">{errors.phone}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="person-wechat">微信号 <span className="label-optional">可选</span></label>
              <input
                id="person-wechat"
                value={wechat}
                maxLength={PERSON_LIMITS.wechat + 1}
                onChange={updateField("wechat", setWechat)}
                aria-invalid={Boolean(errors.wechat)}
                aria-describedby={errors.wechat ? "person-wechat-error" : undefined}
              />
              {errors.wechat ? <span id="person-wechat-error" className="field-error" role="alert">{errors.wechat}</span> : null}
            </div>

            <div className="form-field">
              <label htmlFor="person-tags">人物标签 <span className="label-optional">可选</span></label>
              <input
                id="person-tags"
                value={tags}
                onChange={updateField("tags", setTags)}
                placeholder="用逗号或顿号分隔"
                aria-invalid={Boolean(errors.tags)}
                aria-describedby={errors.tags ? "person-tags-error" : "person-tags-hint"}
              />
              <span id="person-tags-hint" className="field-hint">最多 {PERSON_LIMITS.tags} 个标签</span>
              {errors.tags ? <span id="person-tags-error" className="field-error" role="alert">{errors.tags}</span> : null}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="person-note">关系洞察 <span className="label-optional">可选</span></label>
            <textarea
              id="person-note"
              rows="3"
              value={note}
              maxLength={PERSON_LIMITS.note + 1}
              onChange={updateField("note", setNote)}
              placeholder="记录这位人物的关系背景或联系建议"
              aria-invalid={Boolean(errors.note)}
              aria-describedby={errors.note ? "person-note-error" : undefined}
            />
            <span className="field-counter">{note.length}/{PERSON_LIMITS.note}</span>
            {errors.note ? <span id="person-note-error" className="field-error" role="alert">{errors.note}</span> : null}
          </div>

          <div className="relation-form__actions">
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={avatarBusy}>
              <FloppyDisk size={18} weight="bold" />{mode === "edit" ? "保存人物" : "新增人物"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
