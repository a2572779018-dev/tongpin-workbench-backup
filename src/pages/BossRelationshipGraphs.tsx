import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Clock3,
  Eye,
  Network,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { UserAvatar } from "../components/UserAvatar";
import { BOSS_RELATIONSHIP_GRAPHS_PATH } from "../../shared/relationshipGraphMirror";
import {
  bossRelationshipGraphErrorMessage,
  bossRelationshipGraphNote,
  formatRelationshipGraphSyncedAt,
  sortBossRelationshipGraphMembers,
  summarizeBossRelationshipGraphs,
  type BossRelationshipGraphDetail,
  type BossRelationshipGraphMember,
} from "../lib/bossRelationshipGraphs";
import { normalizeUser } from "../lib/user";
import "./BossRelationshipGraphs.css";

// The graph components (React Flow, GSAP, editor CSS) load only when a map is opened.
const RelationshipMapReadOnlyView = lazy(async () => {
  const module = await import("./RelationshipMapPage");
  return { default: module.RelationshipMapReadOnlyView };
});

interface ViewerState {
  member: BossRelationshipGraphMember;
  detail: BossRelationshipGraphDetail | null;
  error: string;
}

export function BossRelationshipGraphs() {
  const { api } = useAuth();
  const [members, setMembers] = useState<BossRelationshipGraphMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const loadGeneration = useRef(0);
  const viewGeneration = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const loadMembers = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ members: BossRelationshipGraphMember[] }>(
        BOSS_RELATIONSHIP_GRAPHS_PATH,
      );
      if (generation !== loadGeneration.current) return;
      setMembers(
        result.members.map((member) => ({
          user: normalizeUser(member.user),
          snapshot: member.snapshot ?? null,
        })),
      );
    } catch (caught) {
      if (generation !== loadGeneration.current) return;
      setError(bossRelationshipGraphErrorMessage(caught, "成员客户脉络图加载失败"));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadMembers();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [loadMembers]);

  const openViewer = useCallback(
    async (member: BossRelationshipGraphMember, trigger?: HTMLElement | null) => {
      if (!member.snapshot) return;
      returnFocusRef.current = trigger ?? null;
      const generation = ++viewGeneration.current;
      setViewer({ member, detail: null, error: "" });
      try {
        const detail = await api<BossRelationshipGraphDetail>(
          `${BOSS_RELATIONSHIP_GRAPHS_PATH}/${encodeURIComponent(member.user.id)}`,
          {},
          60_000,
        );
        if (generation !== viewGeneration.current) return;
        setViewer({
          member,
          detail: { ...detail, user: normalizeUser(detail.user) },
          error: "",
        });
      } catch (caught) {
        if (generation !== viewGeneration.current) return;
        setViewer({
          member,
          detail: null,
          error: bossRelationshipGraphErrorMessage(caught, "客户脉络图加载失败"),
        });
      }
    },
    [api],
  );

  const closeViewer = useCallback(() => {
    viewGeneration.current += 1;
    setViewer(null);
    const trigger = returnFocusRef.current;
    returnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  const sortedMembers = useMemo(() => sortBossRelationshipGraphMembers(members), [members]);
  const totals = useMemo(() => summarizeBossRelationshipGraphs(members), [members]);
  const viewerSnapshot = viewer?.detail?.snapshot ?? viewer?.member.snapshot ?? null;
  const viewerNote = viewerSnapshot ? bossRelationshipGraphNote(viewerSnapshot) : "";

  return (
    <div className="boss-page member-graphs-page">
      <section className="team-audit bento-panel member-graphs-intro">
        <header>
          <div>
            <span className="eyebrow">只读 · 成员同步</span>
            <h2>谁的客户脉络已经同步？</h2>
          </div>
          <button
            className="secondary-button member-graphs-refresh"
            type="button"
            onClick={() => void loadMembers()}
            disabled={loading}
          >
            <RefreshCw size={17} />
            {loading ? "正在刷新" : "刷新"}
          </button>
        </header>
        <p className="member-graphs-intro__lede">
          成员在本机保存客户脉络图后，会自动同步一份只读副本到这里。你只能查看，不能修改、导入或导出成员的数据；成员本机的加密文件仍是原始数据。
        </p>
      </section>

      <section className="team-stats">
        <article className="metric-tile tile-yellow">
          <span className="eyebrow">成员</span>
          <strong>{totals.people}</strong>
        </article>
        <article className="metric-tile tile-green">
          <span className="eyebrow">已同步</span>
          <strong>{totals.synced}</strong>
        </article>
        <article className="metric-tile tile-pink">
          <span className="eyebrow">未同步</span>
          <strong>{totals.unsynced}</strong>
        </article>
        <article className="metric-tile tile-blue">
          <span className="eyebrow">客户总数</span>
          <strong>{totals.contacts}</strong>
        </article>
      </section>

      <section className="team-registry">
        <header className="section-heading">
          <div>
            <h2>成员脉络</h2>
          </div>
        </header>
        {error && <div className="inline-error">{error}</div>}
        <div className="member-grid member-graph-grid">
          {loading && members.length === 0 ? (
            Array.from({ length: 4 }, (_, index) => (
              <div className="member-card member-card--skeleton" key={index} />
            ))
          ) : sortedMembers.length === 0 ? (
            <div className="team-empty">
              <UsersRound size={28} />
              <b>还没有可查看的成员</b>
            </div>
          ) : (
            sortedMembers.map((member, index) => {
              const { user, snapshot } = member;
              return (
                <button
                  key={user.id}
                  className={[
                    "member-card",
                    `member-card--${index % 4}`,
                    "member-graph-card",
                    snapshot ? "" : "is-unsynced",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  disabled={!snapshot}
                  aria-label={
                    snapshot
                      ? `查看${user.name}的客户脉络图`
                      : `${user.name}尚未同步客户脉络图`
                  }
                  onClick={(event) => void openViewer(member, event.currentTarget)}
                >
                  <span className="member-card__topline">
                    <span>成员 {String(index + 1).padStart(2, "0")}</span>
                    <i className={snapshot ? "is-synced" : "is-unsynced"}>
                      {snapshot ? "已同步" : "未同步"}
                    </i>
                  </span>
                  <span className="member-card__name">
                    <UserAvatar user={user} className="member-card__avatar" />
                    <span>
                      <b>{user.name}</b>
                      <small>{user.jobTitle || "成员"}</small>
                    </span>
                  </span>
                  <span className="member-graph-card__meta">
                    <span>
                      <Network size={14} aria-hidden="true" />
                      {snapshot
                        ? `${snapshot.contactCount} 位客户 · ${snapshot.connectionCount} 条关系`
                        : "尚无同步副本"}
                    </span>
                    <span>
                      <Clock3 size={14} aria-hidden="true" />
                      {snapshot
                        ? `同步于 ${formatRelationshipGraphSyncedAt(snapshot.syncedAt)}`
                        : "成员保存客户脉络图后自动同步"}
                    </span>
                  </span>
                  {snapshot ? (
                    <span className="member-graph-card__open">
                      <Eye size={15} aria-hidden="true" />
                      查看脉络图
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </section>

      {viewer
        ? createPortal(
            <div
              className="member-graph-viewer"
              role="dialog"
              aria-modal="true"
              aria-label={`${viewer.member.user.name}的客户脉络图（只读）`}
            >
              <header className="member-graph-viewer__bar">
                <button
                  className="member-graph-viewer__back"
                  type="button"
                  onClick={closeViewer}
                  autoFocus
                >
                  <ArrowLeft size={17} />
                  返回成员列表
                </button>
                <div className="member-graph-viewer__title">
                  <UserAvatar
                    user={viewer.member.user}
                    className="member-graph-viewer__avatar"
                  />
                  <span>
                    <b>{viewer.member.user.name}的客户脉络图</b>
                    <small>{viewerNote}</small>
                  </span>
                </div>
                <span className="member-graph-viewer__badge">
                  <Eye size={14} aria-hidden="true" />
                  只读
                </span>
              </header>
              <div className="member-graph-viewer__canvas">
                {viewer.error ? (
                  <div className="member-graph-viewer__state" role="alert">
                    <b>{viewer.error}</b>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void openViewer(viewer.member, returnFocusRef.current)}
                    >
                      <RefreshCw size={17} />
                      重新载入
                    </button>
                  </div>
                ) : viewer.detail ? (
                  <Suspense
                    fallback={
                      <div className="member-graph-viewer__state" role="status">
                        正在打开客户脉络图…
                      </div>
                    }
                  >
                    <RelationshipMapReadOnlyView
                      viewerKey={`${viewer.detail.user.id}:${viewer.detail.snapshot.contentHash}`}
                      graph={viewer.detail.graph}
                      note={viewerNote}
                    />
                  </Suspense>
                ) : (
                  <div className="member-graph-viewer__state" role="status">
                    正在载入客户脉络图…
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
