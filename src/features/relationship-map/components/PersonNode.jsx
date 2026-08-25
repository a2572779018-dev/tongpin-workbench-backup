import { memo, useEffect, useState } from "react";
import { Handle, NodeToolbar, Position } from "@xyflow/react";
import { LockKey, Plus } from "@phosphor-icons/react";

const levelLabels = {
  self: "关系中心",
  core: "核心圈",
  close: "常联系",
  acquaintance: "偶尔联系",
  weak: "弱联系",
};

function PersonNodeComponent({ data, selected }) {
  const isRoot = data.id === "self";
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [data.avatar]);
  const classNames = [
    "person-node",
    `person-node--${data.level}`,
    isRoot ? "person-node--root" : "",
    selected ? "is-selected" : "",
    data.isMatch ? "is-match" : "",
    data.isMuted ? "is-muted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const stopGraphGesture = (event) => event.stopPropagation();

  return (
    <div className={`person-node-shell ${isRoot ? "person-node-shell--root" : ""}`}>
      <div
        className={classNames}
        role="button"
        tabIndex={0}
        aria-label={`${data.visualName}，${levelLabels[data.level]}，点击聚焦并打开快捷卡片`}
        aria-pressed={selected}
        aria-expanded={Boolean(data.quickCardOpen)}
        aria-controls={`quick-card-${data.id}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const root = event.currentTarget.getRootNode();
            event.currentTarget.click();
            window.requestAnimationFrame(() => {
              const quickCard = root instanceof ShadowRoot
                ? root.getElementById(`quick-card-${data.id}`)
                : document.getElementById(`quick-card-${data.id}`);
              const detailButton = quickCard?.querySelector(".quick-card-detail");
              if (detailButton instanceof HTMLElement) detailButton.focus();
            });
          }
        }}
      >
        <Handle id="target-left" className="flow-handle" type="target" position={Position.Left} />
        <Handle id="target-top" className="flow-handle" type="target" position={Position.Top} />
        <Handle id="target-right" className="flow-handle" type="target" position={Position.Right} />
        <Handle id="target-bottom" className="flow-handle" type="target" position={Position.Bottom} />
        <div className="person-avatar" aria-hidden="true">
          {data.privacy && !isRoot ? (
            <LockKey size={17} weight="bold" />
          ) : data.avatar && !avatarFailed ? (
            <img src={data.avatar} alt="" onError={() => setAvatarFailed(true)} />
          ) : (
            <span>{data.initial}</span>
          )}
        </div>
        <div className="person-caption">
          <span className="person-name">{data.visualName}</span>
          {isRoot ? <span className="person-level">关系中心</span> : null}
        </div>
        <Handle id="source-left" className="flow-handle" type="source" position={Position.Left} />
        <Handle id="source-top" className="flow-handle" type="source" position={Position.Top} />
        <Handle id="source-right" className="flow-handle" type="source" position={Position.Right} />
        <Handle id="source-bottom" className="flow-handle" type="source" position={Position.Bottom} />
      </div>

      <NodeToolbar
        isVisible={Boolean(data.quickCardOpen)}
        position={data.quickCardSide === "left" ? Position.Left : Position.Right}
        offset={18}
      >
        <aside
          id={`quick-card-${data.id}`}
          className="person-quick-card nodrag nopan nowheel"
          aria-label={`${data.visualName}快捷卡片`}
          onClick={stopGraphGesture}
          onPointerDown={stopGraphGesture}
        >
          <button
            className="quick-card-detail nodrag nopan"
            type="button"
            data-quick-detail-for={data.id}
            aria-label={`查看${data.visualName}完整详情`}
            title="查看完整详情"
            onPointerDown={stopGraphGesture}
            onClick={(event) => {
              event.stopPropagation();
              data.onOpenDetails?.(data.id);
            }}
          >
            详
          </button>

          <div className="quick-card-copy">
            <span className="quick-card-kicker">{levelLabels[data.level]}</span>
            <strong>{data.visualName}</strong>
            <p>{data.privacy ? "人物身份已脱敏" : `${data.relationship || "未分类"} · ${data.community || "未分组"}`}</p>
          </div>

          <div className="quick-card-meta" aria-label="人物关系摘要">
            <span>{data.relationCount || 0} 条关系</span>
            <span>{data.privacy ? "本地资料" : data.lastContact || "暂无联系记录"}</span>
          </div>

          <button
            className="quick-card-add nodrag nopan"
            type="button"
            aria-label={`为${data.visualName}新增关系`}
            title="新增关系"
            onPointerDown={stopGraphGesture}
            onClick={(event) => {
              event.stopPropagation();
              data.onAddRelation?.(data.id);
            }}
          >
            <Plus size={22} weight="bold" aria-hidden="true" />
          </button>
        </aside>
      </NodeToolbar>
    </div>
  );
}

export const PersonNode = memo(PersonNodeComponent);
