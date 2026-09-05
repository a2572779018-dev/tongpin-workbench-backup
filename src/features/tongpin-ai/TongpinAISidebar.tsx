import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../../types";
import { TongpinAIAccountUsage } from "./TongpinAIAccountUsage";
import type {
  TongpinAIConversation,
  TongpinAIProject,
  TongpinAIUsage,
  TongpinAIWorkspaceView,
} from "./types";

interface TongpinAISidebarProps {
  activeConversationId: string | null;
  activeProjectId: string | null;
  collapsed: boolean;
  conversations: TongpinAIConversation[];
  projects: TongpinAIProject[];
  skillCount: number;
  usage: TongpinAIUsage;
  quotaSynced?: boolean;
  onRefreshUsage?: () => Promise<void>;
  user: User;
  view: TongpinAIWorkspaceView;
  onToggleSidebar: () => void;
  onNewConversation: () => void;
  onNewProject: () => void;
  onNewProjectConversation: (projectId: string) => void;
  onOpenSkills: () => void;
  onDeleteProject: (projectId: string) => void;
  onRenameProject: (projectId: string) => void;
  onRenameConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onMoveConversation: (conversationId: string, projectId?: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectProject: (projectId: string) => void;
}

type SidebarMenu = {
  kind: "project" | "conversation";
  id: string;
  x: number;
  y: number;
  moving?: boolean;
};

export function TongpinAISidebar({
  activeConversationId,
  activeProjectId,
  collapsed,
  conversations,
  projects,
  skillCount,
  usage,
  quotaSynced = false,
  onRefreshUsage,
  user,
  view,
  onToggleSidebar,
  onNewConversation,
  onNewProject,
  onNewProjectConversation,
  onOpenSkills,
  onDeleteProject,
  onRenameProject,
  onRenameConversation,
  onDeleteConversation,
  onMoveConversation,
  onSelectConversation,
  onSelectProject,
}: TongpinAISidebarProps) {
  const [ordinaryConversationsOpen, setOrdinaryConversationsOpen] =
    useState(true);
  const [closedProjects, setClosedProjects] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOriginRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const previousConversationId = useRef(activeConversationId);
  const previousConversationProjectId = useRef(
    conversations.find((item) => item.id === activeConversationId)?.projectId,
  );
  const query = search.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(query);
  const standaloneConversations = conversations.filter(
    (item) => !item.projectId,
  );
  const visibleStandaloneConversations = standaloneConversations.filter(
    (item) => matches(item.title),
  );
  const visibleProjects = projects.filter(
    (project) =>
      matches(project.title) ||
      conversations.some(
        (item) => item.projectId === project.id && matches(item.title),
      ),
  );
  const menuConversation =
    menu?.kind === "conversation"
      ? conversations.find((item) => item.id === menu.id)
      : undefined;

  useEffect(() => {
    const activeConversation = conversations.find(
      (item) => item.id === activeConversationId,
    );
    if (
      activeConversation &&
      !activeConversation.projectId &&
      (activeConversationId !== previousConversationId.current ||
        previousConversationProjectId.current)
    ) {
      setOrdinaryConversationsOpen(true);
      setSearch("");
    }
    previousConversationId.current = activeConversationId;
    previousConversationProjectId.current = activeConversation?.projectId;
  }, [activeConversationId, conversations]);

  useEffect(() => {
    if (!activeProjectId) return;
    setClosedProjects((current) => {
      if (!current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.delete(activeProjectId);
      return next;
    });
  }, [activeProjectId]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        menuOriginRef.current?.focus();
      } else if (event.key === "Tab") {
        setMenu(null);
        menuOriginRef.current?.focus();
      }
    }
    function onViewportChange(event: Event) {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      setMenu(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [menu]);

  useEffect(() => {
    if (collapsed || !window.matchMedia("(max-width: 760px)").matches) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    toggleRef.current?.focus();
    function onDrawerKeyDown(event: KeyboardEvent) {
      if (
        menuRef.current ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        onToggleSidebar();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onDrawerKeyDown);
    return () => {
      document.removeEventListener("keydown", onDrawerKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [collapsed, onToggleSidebar]);

  function openMenu(
    kind: SidebarMenu["kind"],
    id: string,
    x: number,
    y: number,
    origin: HTMLElement | null,
  ) {
    menuOriginRef.current = origin;
    setMenu({
      kind,
      id,
      x: Math.max(8, Math.min(x, window.innerWidth - 232)),
      y: Math.max(8, Math.min(y, window.innerHeight - 230)),
    });
  }

  function runMenuAction(action: () => void) {
    setMenu(null);
    menuOriginRef.current?.focus();
    action();
  }

  function navigate(action: () => void) {
    action();
    if (!collapsed && window.matchMedia("(max-width: 760px)").matches)
      onToggleSidebar();
  }

  function conversationRow(conversation: TongpinAIConversation) {
    const active = view === "chat" && activeConversationId === conversation.id;
    return (
      <div
        key={conversation.id}
        className={"tp-ai-conversation-row" + (active ? " is-active" : "")}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu(
            "conversation",
            conversation.id,
            event.clientX,
            event.clientY,
            event.currentTarget.querySelector<HTMLButtonElement>(
              ".tp-ai-conversation-row__more",
            ),
          );
        }}
      >
        <button
          type="button"
          className="tp-ai-conversation-row__select"
          aria-current={active ? "page" : undefined}
          title={conversation.title}
          onClick={() => navigate(() => onSelectConversation(conversation.id))}
        >
          <MessageSquare size={15} aria-hidden="true" />
          <span>{conversation.title}</span>
        </button>
        <button
          type="button"
          className="tp-ai-conversation-row__more"
          aria-label={"打开“" + conversation.title + "”对话菜单"}
          aria-haspopup="menu"
          data-conversation-menu-trigger={conversation.id}
          aria-expanded={
            menu?.kind === "conversation" && menu.id === conversation.id
          }
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            openMenu(
              "conversation",
              conversation.id,
              bounds.right,
              bounds.bottom + 4,
              event.currentTarget,
            );
          }}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      {!collapsed ? (
        <button
          type="button"
          className="tp-ai-sidebar-backdrop"
          tabIndex={-1}
          aria-label="关闭侧边栏"
          onClick={onToggleSidebar}
        />
      ) : null}
      <aside
        ref={sidebarRef}
        className={"tp-ai-sidebar" + (collapsed ? " is-collapsed" : "")}
        aria-label="AI 工作台导航"
      >
        <header className="tp-ai-sidebar__brand">
          <span className="tp-ai-sidebar__mark" aria-hidden="true">
            <img src="./app-icon.svg" alt="" />
          </span>
          <strong className="tp-ai-sidebar__brand-name">同频 AI</strong>
          <button
            ref={toggleRef}
            type="button"
            className="tp-ai-sidebar__toggle"
            onClick={onToggleSidebar}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {collapsed ? (
              <PanelLeftOpen size={19} />
            ) : (
              <PanelLeftClose size={19} />
            )}
          </button>
        </header>

        <div className="tp-ai-sidebar__primary-actions">
          <button
            type="button"
            className="is-primary"
            title="新对话"
            onClick={onNewConversation}
          >
            <MessageSquarePlus size={18} />
            <span>新对话</span>
          </button>
          <button type="button" title="新项目" onClick={onNewProject}>
            <FolderPlus size={18} />
            <span>新项目</span>
          </button>
        </div>
        <nav className="tp-ai-sidebar__nav" aria-label="AI 功能">
          <button
            type="button"
            className={view === "skills" ? "is-active" : ""}
            title="Skill 市场"
            aria-current={view === "skills" ? "page" : undefined}
            onClick={() => navigate(onOpenSkills)}
          >
            <Sparkles size={18} />
            <span>Skill 市场</span>
            <b>{skillCount}</b>
          </button>
        </nav>

        <div className="tp-ai-sidebar__search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索项目和对话"
            placeholder="搜索项目和对话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setSearch("")}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="tp-ai-sidebar__scroll-region">
          <section
            className="tp-ai-projects"
            aria-labelledby="tp-ai-projects-title"
          >
            <header>
              <span id="tp-ai-projects-title">
                <FolderKanban size={14} />
                项目
              </span>
              <small>{projects.length}</small>
            </header>
            {projects.length === 0 ? (
              <p className="tp-ai-sidebar__empty">暂无项目</p>
            ) : visibleProjects.length === 0 ? (
              <p className="tp-ai-sidebar__empty">没有匹配的项目</p>
            ) : (
              <div className="tp-ai-projects__list">
                {visibleProjects.map((project) => {
                  const projectConversations = conversations.filter(
                    (item) => item.projectId === project.id,
                  );
                  const visibleConversations = matches(project.title)
                    ? projectConversations
                    : projectConversations.filter((item) =>
                        matches(item.title),
                      );
                  const projectActive = activeProjectId === project.id;
                  const expanded =
                    Boolean(query) || !closedProjects.has(project.id);
                  return (
                    <article
                      key={project.id}
                      className={projectActive ? "is-active" : ""}
                    >
                      <div
                        className="tp-ai-project-row"
                        onContextMenu={(event) => {
                          event.preventDefault();
                          openMenu(
                            "project",
                            project.id,
                            event.clientX,
                            event.clientY,
                            event.currentTarget.querySelector<HTMLButtonElement>(
                              ".tp-ai-project-row__more",
                            ),
                          );
                        }}
                      >
                        <button
                          type="button"
                          className="tp-ai-project-row__expand"
                          aria-label={
                            (expanded ? "收起“" : "展开“") +
                            project.title +
                            "”的对话"
                          }
                          aria-expanded={expanded}
                          aria-controls={"tp-ai-project-chats-" + project.id}
                          onClick={() => {
                            if (query) setSearch("");
                            setClosedProjects((current) => {
                              const next = new Set(current);
                              if (expanded) next.add(project.id);
                              else next.delete(project.id);
                              return next;
                            });
                          }}
                        >
                          {expanded ? (
                            <ChevronDown size={14} />
                          ) : (
                            <ChevronRight size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="tp-ai-project-row__select"
                          title={project.title}
                          aria-current={
                            projectActive && view === "project"
                              ? "page"
                              : undefined
                          }
                          onClick={() =>
                            navigate(() => onSelectProject(project.id))
                          }
                        >
                          <FolderOpen size={16} aria-hidden="true" />
                          <span>
                            <strong>{project.title}</strong>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="tp-ai-project-row__new-chat"
                          aria-label={"在“" + project.title + "”中新建对话"}
                          title="在项目中新建对话"
                          onClick={() => onNewProjectConversation(project.id)}
                        >
                          <Plus size={15} />
                        </button>
                        <button
                          type="button"
                          className="tp-ai-project-row__more"
                          aria-haspopup="menu"
                          aria-label={"打开“" + project.title + "”项目菜单"}
                          title="项目菜单"
                          aria-expanded={
                            menu?.kind === "project" && menu.id === project.id
                          }
                          data-project-menu-trigger={project.id}
                          onClick={(event) => {
                            const bounds =
                              event.currentTarget.getBoundingClientRect();
                            openMenu(
                              "project",
                              project.id,
                              bounds.right,
                              bounds.bottom + 4,
                              event.currentTarget,
                            );
                          }}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                      <div
                        className="tp-ai-project-chats"
                        id={"tp-ai-project-chats-" + project.id}
                        role="group"
                        aria-label={project.title + "中的对话"}
                        hidden={!expanded}
                      >
                        {visibleConversations.map(conversationRow)}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <section
            className={
              "tp-ai-history" +
              (ordinaryConversationsOpen || query ? "" : " is-collapsed")
            }
            aria-labelledby="tp-ai-history-title"
          >
            <header>
              <button
                type="button"
                className="tp-ai-history__toggle"
                aria-expanded={ordinaryConversationsOpen || Boolean(query)}
                aria-controls="tp-ai-history-list"
                aria-label={
                  ordinaryConversationsOpen || query
                    ? "折叠普通对话"
                    : "展开普通对话"
                }
                onClick={() => {
                  if (query) {
                    setSearch("");
                    setOrdinaryConversationsOpen(false);
                  } else setOrdinaryConversationsOpen((current) => !current);
                }}
              >
                <span id="tp-ai-history-title">
                  <Clock3 size={14} />
                  普通对话
                </span>
                <span className="tp-ai-history__toggle-meta" aria-hidden="true">
                  <small>{standaloneConversations.length}</small>
                  <ChevronDown size={15} />
                </span>
              </button>
            </header>
            <div
              className="tp-ai-history__list"
              id="tp-ai-history-list"
              hidden={!ordinaryConversationsOpen && !query}
            >
              {visibleStandaloneConversations.map(conversationRow)}
              {visibleStandaloneConversations.length === 0 ? (
                <p className="tp-ai-sidebar__empty">
                  {query ? "没有匹配的对话" : "暂无对话"}
                </p>
              ) : null}
            </div>
          </section>
        </div>
        <TongpinAIAccountUsage usage={usage} user={user} quotaSynced={quotaSynced} onRefresh={onRefreshUsage} />
      </aside>

      {menu
        ? createPortal(
            <div
              ref={menuRef}
              className="tp-ai-sidebar-menu tp-ai-metal-menu"
              role="menu"
              aria-label={
                menu.moving
                  ? "选择目标项目"
                  : menu.kind === "project"
                    ? "项目操作"
                    : "对话操作"
              }
              style={{
                left: menu.x,
                top: menu.y,
                maxHeight: "calc(100vh - " + (menu.y + 8) + "px)",
              }}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                )
                  return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ),
                );
                if (!items.length) return;
                event.preventDefault();
                const current = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : event.key === "ArrowDown"
                        ? (current + 1 + items.length) % items.length
                        : (current - 1 + items.length) % items.length;
                items[next]?.focus();
              }}
            >
              {menu.moving ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setMenu({ ...menu, moving: false })}
                  >
                    <ArrowLeft size={15} />
                    返回
                  </button>
                  <div
                    className="tp-ai-sidebar-menu__divider"
                    role="separator"
                  />
                  {projects
                    .filter(
                      (project) => project.id !== menuConversation?.projectId,
                    )
                    .map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          runMenuAction(() =>
                            onMoveConversation(menu.id, project.id),
                          )
                        }
                      >
                        <FolderOpen size={15} />
                        <span>{project.title}</span>
                      </button>
                    ))}
                </>
              ) : (
                <>
                  {menu.kind === "project" ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runMenuAction(() => onNewProjectConversation(menu.id))
                      }
                    >
                      <MessageSquarePlus size={15} />
                      新建对话
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      runMenuAction(() =>
                        menu.kind === "project"
                          ? onRenameProject(menu.id)
                          : onRenameConversation(menu.id),
                      )
                    }
                  >
                    <Pencil size={15} />
                    重命名
                  </button>
                  {menu.kind === "conversation" &&
                  projects.some(
                    (item) => item.id !== menuConversation?.projectId,
                  ) ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => setMenu({ ...menu, moving: true })}
                    >
                      <FolderInput size={15} />
                      移入项目
                      <ChevronRight size={14} />
                    </button>
                  ) : null}
                  {menuConversation?.projectId ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        runMenuAction(() => onMoveConversation(menu.id))
                      }
                    >
                      <FolderOutput size={15} />
                      移出项目
                    </button>
                  ) : null}
                  <div
                    className="tp-ai-sidebar-menu__divider"
                    role="separator"
                  />
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={() =>
                      runMenuAction(() =>
                        menu.kind === "project"
                          ? onDeleteProject(menu.id)
                          : onDeleteConversation(menu.id),
                      )
                    }
                  >
                    <Trash2 size={15} />
                    {menu.kind === "project" ? "删除项目" : "删除对话"}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
