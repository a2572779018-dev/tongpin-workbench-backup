import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import {
  CalendarDots,
  ChatCircleText,
  ClockCounterClockwise,
  Handshake,
  LockKey,
  PencilSimple,
  Phone,
  Plus,
  Trash,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { customerCooperationStatusLabel } from "../data/customerStatus.js";

function privateValue(value, privacy, kind) {
  if (!privacy) return value;
  if (kind === "phone") return "••• •••• ••••";
  if (kind === "wechat") return "已隐藏";
  if (kind === "contact") return "已隐藏";
  return value;
}

export function DetailPanel({ person, privacy, visualName, relations, onAddRelation, onEditRelation, onDeleteRelation, onEditPerson, onDeletePerson, onClose }) {
  const panelRef = useRef(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [person.avatar]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const animation = gsap.fromTo(
      panel,
      { x: 48, opacity: 0, scale: 0.98 },
      { x: 0, opacity: 1, scale: 1, duration: reduceMotion ? 0 : 0.42, ease: "power3.out" },
    );

    return () => animation.kill();
  }, [person.id]);

  return (
    <aside ref={panelRef} className="detail-panel" aria-label={`${visualName}的关系详情`}>
      <div className="detail-panel__topline">
        <span className="detail-kicker">客户详情</span>
        <div className="detail-panel__top-actions">
          {!privacy ? (
            <button className="icon-button icon-button--small" type="button" onClick={() => onEditPerson(person.id)} aria-label={`编辑${visualName}的客户资料`} title="编辑客户" data-person-focus-fallback="detail">
              <PencilSimple size={17} weight="bold" />
            </button>
          ) : null}
          {person.id !== "self" ? (
            <button className="icon-button icon-button--small person-delete-button" type="button" onClick={() => onDeletePerson(person.id)} aria-label={`删除客户${visualName}`} title="删除客户">
              <Trash size={17} weight="bold" />
            </button>
          ) : null}
          <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭客户详情" autoFocus>
            <X size={18} weight="bold" />
          </button>
        </div>
      </div>

      <div className="detail-identity">
        <div className="detail-avatar" aria-hidden="true">
          {privacy && person.id !== "self" ? (
            <LockKey size={24} weight="bold" />
          ) : person.avatar && !avatarFailed ? (
            <img src={person.avatar} alt="" onError={() => setAvatarFailed(true)} />
          ) : (
            person.initial
          )}
        </div>
        <div>
          <h2>{visualName}</h2>
          <p>{privacy && person.id !== "self" ? "身份信息已保护" : person.alias}</p>
        </div>
      </div>

      <div className="tag-row" aria-label="客户标签">
        {privacy ? <span className="detail-tag">标签已隐藏</span> : person.tags.map((tag) => (
          <span className="detail-tag" key={tag}>{tag}</span>
        ))}
      </div>

      <section className="detail-section detail-relations">
        <div className="detail-section__heading">
          <h3>相关关系</h3>
          <button className="mini-action-button" type="button" onClick={() => onAddRelation(person.id)} data-relation-focus-fallback="detail">
            <Plus size={14} weight="bold" />新增
          </button>
        </div>
        {relations.length > 0 ? (
          <ul className="detail-relation-list">
            {relations.map((relation) => (
              <li key={`${relation.index}-${relation.source}-${relation.target}`}>
                <div className="detail-relation-list__content">
                  <div>
                    <strong>{relation.otherVisualName}</strong>
                    <span>{relation.relationship}</span>
                    {Number.isFinite(relation.strength) ? <span>{Math.round(relation.strength * 100)}%</span> : null}
                  </div>
                  {relation.note ? <p>{privacy ? "关系备注已隐藏" : relation.note}</p> : null}
                </div>
                <div className="detail-relation-list__actions">
                  {!privacy ? (
                    <button
                      className="relation-icon-button"
                      type="button"
                      onClick={() => onEditRelation(relation.index)}
                      aria-label={`编辑与${relation.otherVisualName}的${relation.relationship}关系`}
                      title="编辑关系"
                    >
                      <PencilSimple size={15} weight="bold" />
                    </button>
                  ) : null}
                  <button
                    className="relation-icon-button relation-icon-button--danger"
                    type="button"
                    onClick={() => onDeleteRelation(relation.index)}
                    aria-label={`删除与${relation.otherVisualName}的${relation.relationship}关系`}
                    title="删除关系"
                  >
                    <Trash size={15} weight="bold" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="detail-empty-state">暂无相关连接，可从这里新增。</p>
        )}
      </section>

      <section className="detail-section">
        <h3>近 30 天互动</h3>
        <div className="metric-grid">
          <article>
            <ChatCircleText size={20} weight="duotone" />
            <strong>{person.interactions}</strong>
            <span>互动次数</span>
          </article>
          <article>
            <CalendarDots size={20} weight="duotone" />
            <strong>{person.activeDays}</strong>
            <span>活跃天数</span>
          </article>
          <article>
            <UsersThree size={20} weight="duotone" />
            <strong>{person.mutual}</strong>
            <span>共同联系人</span>
          </article>
        </div>
      </section>

      <section className="detail-section">
        <h3>联系资料</h3>
        <dl className="profile-list">
          {person.id !== "self" ? (
            <div>
              <dt><Handshake size={18} />合作状态</dt>
              <dd>{privacy ? "已隐藏" : customerCooperationStatusLabel(person.cooperationStatus)}</dd>
            </div>
          ) : null}
          <div>
            <dt><ClockCounterClockwise size={18} />最近联系</dt>
            <dd>{privateValue(person.lastContact, privacy, "contact")}</dd>
          </div>
          <div>
            <dt><Phone size={18} />手机号</dt>
            <dd>{privateValue(person.phone, privacy, "phone")}</dd>
          </div>
          <div>
            <dt><ChatCircleText size={18} />微信号</dt>
            <dd>{privateValue(person.wechat, privacy, "wechat")}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-note">
        <h3>合作记录</h3>
        <p>{privacy ? "客户备注已隐藏" : person.note}</p>
      </section>
    </aside>
  );
}
