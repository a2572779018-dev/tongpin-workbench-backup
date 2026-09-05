import { FileText, Info, PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiRequestError } from "../lib/api";
import type { AiChatRequest, AiChatResponse, AiImageRequest, AiImageResponse, AiStatus } from "../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceSaveRequest, AiWorkspaceSnapshot } from "../../shared/aiWorkspace";
import { useWorkspacePersistence } from "../features/tongpin-ai/useWorkspacePersistence";
import { liveConversation, withoutConversation } from "../features/tongpin-ai/conversationOperations";
import { registerAiLeaveGuard } from "../features/tongpin-ai/workspaceLeaveGuard";
import { PersonaSetup } from "../features/tongpin-ai/PersonaSetup";
import type { AiPersonaSnapshot } from "../../shared/aiPersona";
import { extractAttachment, validateAttachments } from "../features/tongpin-ai/attachments";
import { selectSkill, skillRequestIds } from "../features/tongpin-ai/skills";
import { buildChatRequest, canRecoverChatRequest, completedReply, recoverInterruptedMessages, replaceChatMessage } from "../features/tongpin-ai/chatRequests";
import { useNotificationToolbar } from "../components/NotificationToolbarContext";
import { ArtifactPreview } from "../features/tongpin-ai/ArtifactPreview";
import { ChatWorkspace } from "../features/tongpin-ai/ChatWorkspace";
import { TONGPIN_AI_SKILLS } from "../features/tongpin-ai/mockData";
import { ProjectWorkspaceEmpty } from "../features/tongpin-ai/ProjectWorkspaceEmpty";
import { SkillMarketplace } from "../features/tongpin-ai/SkillMarketplace";
import { TongpinAISidebar } from "../features/tongpin-ai/TongpinAISidebar";
import {
  TongpinAIConversationDeleteDialog,
  TongpinAINameDialog,
  TongpinAIProjectDeleteDialog,
} from "../features/tongpin-ai/TongpinAIWorkspaceDialog";
import {
  hydrateWorkspace,
  moveConversationToProject,
  serializeWorkspace,
} from "../features/tongpin-ai/workspaceState";
import type { User } from "../types";
import type {
  TongpinAIArtifact,
  TongpinAIConversation,
  TongpinAIDemoAction,
  TongpinAIMode,
  TongpinAIProject,
  TongpinAIUsage,
  TongpinAIWorkspaceView,
} from "../features/tongpin-ai/types";
import "../features/tongpin-ai/tongpin-ai.css";
import "../features/tongpin-ai/sidebar-layout.css";
import "../features/tongpin-ai/chat-layout.css";
import "../features/tongpin-ai/ai-metal-theme.css";
import "../features/tongpin-ai/ai-capabilities.css";

type WorkspaceDialogState =
  | { type: "new-project" }
  | { type: "new-conversation"; projectId?: string }
  | { type: "rename-project"; projectId: string }
  | { type: "delete-project"; projectId: string }
  | { type: "rename-conversation"; conversationId: string }
  | { type: "delete-conversation"; conversationId: string }
  | null;

function createLocalId(prefix: string) {
  return prefix + "-" + crypto.randomUUID();
}

function currentTimeLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function TongpinAIPage({ user }: { user: User }) {
  return <WorkspaceLoader key={user.id} user={user} />;
}

function WorkspaceLoader({ user }: { user: User }) {
  const { api } = useAuth();
  const [snapshot, setSnapshot] = useState<AiWorkspaceSnapshot | null>(null);
  const [persona, setPersona] = useState<AiPersonaSnapshot | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const options = { headers: { "X-Tongpin-Account": user.id }, signal: controller.signal };
    void Promise.all([api<AiWorkspaceSnapshot>("/api/ai/workspace", options), api<AiPersonaSnapshot>("/api/ai/persona", options)])
      .then(([workspace, memory]) => { if (!controller.signal.aborted) { setSnapshot(workspace); setPersona(memory); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "工作台暂时无法加载"); });
    return () => controller.abort();
  }, [api, user.id, attempt]);
  if (!snapshot || !persona) return <section className="tp-ai-load-state" aria-live="polite">
    <p>{error || "正在加载你的对话…"}</p>
    {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载</button>}
  </section>;
  return <TongpinAIWorkspace user={user} initialSnapshot={snapshot} persona={persona} onPersonaSaved={setPersona} />;
}

type GenerationRequest = AiChatRequest | AiImageRequest;

function TongpinAIWorkspace({ user, initialSnapshot, persona, onPersonaSaved }: {
  user: User; initialSnapshot: AiWorkspaceSnapshot; persona: AiPersonaSnapshot; onPersonaSaved: (value: AiPersonaSnapshot) => void;
}) {
  const { api } = useAuth();
  const notificationToolbar = useNotificationToolbar();
  const [initialSession] = useState(() => hydrateWorkspace(initialSnapshot.state));
  const [view, setView] = useState<TongpinAIWorkspaceView>(initialSession.view);
  const [personaSettingsOpen, setPersonaSettingsOpen] = useState(false);
  const [mode, setMode] = useState<TongpinAIMode>(initialSession.mode);
  const [conversations, setConversations] = useState<TongpinAIConversation[]>(
    () => recoverInterruptedMessages(initialSession.conversations),
  );
  const [projects, setProjects] = useState<TongpinAIProject[]>(
    initialSession.projects,
  );
  const [artifacts, setArtifacts] = useState<TongpinAIArtifact[]>(
    initialSession.artifacts,
  );
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [responding, setResponding] = useState(false);
  const [responsePhase, setResponsePhase] = useState<"waiting" | "typing">("waiting");
  const requestRef = useRef<{ controller: AbortController; conversationId: string; messageId: string; request: GenerationRequest } | null>(null);
  const retryRequestsRef = useRef(new Map<string, { conversationId: string; request: GenerationRequest }>());
  const completedResponsesRef = useRef(new Map<string, ReturnType<typeof completedReply>>());
  const pendingGenerationRef = useRef<string | null>(null);
  const pendingCancelledRef = useRef(false);
  const fileImportRef = useRef(false);
  const deletingConversationRef = useRef(new Set<string>());
  const deletionTasksRef = useRef(new Map<string, Promise<boolean>>());
  const typingRef = useRef<{ timer: number; finish: () => void } | null>(null);
  const mountedRef = useRef(true);
  const statusGenerationRef = useRef(0);
  const usage: TongpinAIUsage = {
    periodLabel: "累计使用",
    ...(aiStatus?.quota ?? { limitTokens: 0, usedTokens: 0, reservedTokens: 0, remainingTokens: 0, inputTokens: 0, outputTokens: 0 }),
  };
  const refreshStatus = useCallback(async () => {
    const generation = ++statusGenerationRef.current;
    try {
      const next = await api<AiStatus>("/api/ai/status", { headers: { "X-Tongpin-Account": user.id } });
      if (mountedRef.current && generation === statusGenerationRef.current) {
        setAiStatus(next);
        setConnectionError("");
      }
    } catch (error) {
      if (mountedRef.current && generation === statusGenerationRef.current) {
        setConnectionError(error instanceof Error ? error.message : "AI 状态暂时无法获取");
      }
    } finally {
      if (mountedRef.current && generation === statusGenerationRef.current) setConnectionLoading(false);
    }
  }, [api, user.id]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(initialSession.activeConversationId);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    initialSession.activeProjectId,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(
    initialSession.drafts,
  );
  const [draftAttachments, setDraftAttachments] = useState<Record<string, AiWorkspaceDocument[]>>(initialSession.draftAttachments ?? {});
  const [composerTool, setComposerTool] = useState<"text" | "presentation" | "image">(initialSession.composerTool ?? "text");
  const [webSearch, setWebSearch] = useState(initialSession.webSearch ?? false);
  const draftKey =
    activeConversationId ??
    (activeProjectId
      ? `new-project-conversation:${activeProjectId}`
      : "new-conversation");
  const draft = drafts[draftKey] ?? "";
  const attachments = draftAttachments[draftKey] ?? [];
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () =>
      initialSession.sidebarCollapsed ??
      window.matchMedia("(max-width: 760px)").matches,
  );
  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((current) => !current),
    [],
  );
  const serviceConnected = aiStatus?.configured === true;
  const quotaInsufficient = serviceConnected && usage.remainingTokens <= 0;
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [enabledSkillIds, setEnabledSkillIds] = useState<Set<string>>(
    initialSession.enabledSkillIds,
  );
  const [announcement, setAnnouncement] = useState("");
  const [workspaceDialog, setWorkspaceDialog] =
    useState<WorkspaceDialogState>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const announcementTimerRef = useRef<number | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef({ conversations, projects, artifacts, drafts, draftAttachments, activeConversationId, activeProjectId, view, workspaceDialog });
  workspaceRef.current = { conversations, projects, artifacts, drafts, draftAttachments, activeConversationId, activeProjectId, view, workspaceDialog };

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      statusGenerationRef.current += 1;
      window.removeEventListener("focus", onFocus);
      requestRef.current?.controller.abort();
      if (typingRef.current) window.clearTimeout(typingRef.current.timer);
    };
  }, [refreshStatus]);

  const artifactById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );
  const activeConversation =
    conversations.find((item) => item.id === activeConversationId) ?? null;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const activeProjectConversations = activeProject
    ? conversations.filter(
        (conversation) => conversation.projectId === activeProject.id,
      )
    : [];
  const latestConversationArtifactId = [...(activeConversation?.messages ?? [])]
    .reverse()
    .find((message) => message.artifactId)?.artifactId;
  const activeArtifact = activeArtifactId
    ? artifactById.get(activeArtifactId)
    : undefined;
  const latestConversationArtifact = latestConversationArtifactId
    ? artifactById.get(latestConversationArtifactId)
    : undefined;

  useEffect(
    () => () => {
      if (announcementTimerRef.current !== null)
        window.clearTimeout(announcementTimerRef.current);
    },
    [],
  );

  const persistentState = serializeWorkspace({
      view,
      mode,
      // Render the typewriter locally, but persist the full received reply once.
      conversations: conversations.map(conversation => ({ ...conversation, messages: conversation.messages.map(message => {
        const complete = completedResponsesRef.current.get(message.id);
        return message.status === "typing" && complete ? { ...message, ...complete } : message;
      }) })),
      projects,
      artifacts,
      drafts,
      draftAttachments,
      composerTool,
      webSearch,
      activeConversationId,
      activeProjectId,
      enabledSkillIds,
      sidebarCollapsed,
    });
  const writeWorkspace = useCallback((body: AiWorkspaceSaveRequest) => api<AiWorkspaceSnapshot>("/api/ai/workspace", {
    method: "PUT", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(body),
  }), [api, user.id]);
  const persistence = useWorkspacePersistence(initialSnapshot, persistentState, writeWorkspace, user.id);
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const persistentStateRef = useRef(persistentState);
  persistentStateRef.current = persistentState;
  useEffect(() => {
    const unregister = registerAiLeaveGuard(user.id, async () => {
      const results = await Promise.all([...deletionTasksRef.current.values()]);
      return results.every(result => result === true) && persistenceRef.current.flushSaved();
    });
    const guard = (event: BeforeUnloadEvent) => {
      if (deletingConversationRef.current.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => { unregister(); window.removeEventListener("beforeunload", guard); };
  }, [user.id]);

  async function addFiles(files: File[]) {
    if (fileImportRef.current) { showAnnouncement("正在读取附件，请稍候"); return; }
    if (files.length + attachments.length > 5) { showAnnouncement("每次最多添加 5 个附件"); return; }
    fileImportRef.current = true;
    const target = draftKey;
    try {
      const extracted = await Promise.all(files.map(extractAttachment));
      const documents = extracted.map(item => ({ id: createLocalId("document"), name: item.name, mimeType: item.mediaType, content: item.text }));
      if (!mountedRef.current) return;
      const latest = workspaceRef.current;
      const targetExists = target === "new-conversation" || latest.conversations.some(item => item.id === target) || latest.projects.some(item => `new-project-conversation:${item.id}` === target);
      if (!targetExists) return;
      const merged = [...(latest.draftAttachments[target] ?? []), ...documents];
      validateAttachments(merged.map(item => ({ name: item.name, text: item.content, mediaType: item.mimeType })));
      setDraftAttachments(current => ({ ...current, [target]: merged }));
      const warnings = extracted.flatMap(item => item.warnings);
      if (warnings.length) showAnnouncement(warnings.join("；"));
    } catch (error) { if (mountedRef.current) showAnnouncement(error instanceof Error ? error.message : "文件读取失败"); }
    finally { fileImportRef.current = false; }
  }

  function exportWorkspace() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(persistentState, null, 2)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "同频-AI-对话备份.json"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function updateDraft(value: string) {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }

  function showAnnouncement(message: string) {
    setAnnouncement(message);
    if (announcementTimerRef.current !== null)
      window.clearTimeout(announcementTimerRef.current);
    announcementTimerRef.current = window.setTimeout(() => {
      setAnnouncement("");
      announcementTimerRef.current = null;
    }, 3_200);
  }

  function rememberDialogOrigin() {
    dialogReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }

  function rememberMenuOrigin(kind: "project" | "conversation", id: string) {
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogReturnFocusRef.current = focused?.closest(
      ".tp-ai-project-workspace__actions",
    )
      ? focused
      : (document.querySelector<HTMLButtonElement>(
          "[data-" + kind + '-menu-trigger="' + id + '"]',
        ) ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null));
  }

  const closeWorkspaceDialog = useCallback(() => {
    setWorkspaceDialog(null);
    window.requestAnimationFrame(() => {
      if (
        dialogReturnFocusRef.current?.isConnected &&
        dialogReturnFocusRef.current.getClientRects().length > 0
      ) {
        dialogReturnFocusRef.current.focus();
      } else {
        const fallback =
          document.querySelector<HTMLElement>(
            "#tp-ai-project-title, #tp-ai-message-input",
          ) ??
          document.querySelector<HTMLElement>(
            ".tp-ai-sidebar__primary-actions button",
          );
        fallback?.focus();
      }
    });
  }, []);

  function openNewProjectDialog() {
    rememberDialogOrigin();
    setWorkspaceDialog({ type: "new-project" });
  }

  function openNewConversationDialog(projectId?: string) {
    if (projectId && !projects.some((project) => project.id === projectId))
      return;
    rememberDialogOrigin();
    setWorkspaceDialog({ type: "new-conversation", projectId });
  }

  function openRenameProjectDialog(projectId: string) {
    rememberMenuOrigin("project", projectId);
    setWorkspaceDialog({ type: "rename-project", projectId });
  }

  function openDeleteProjectDialog(projectId: string) {
    rememberMenuOrigin("project", projectId);
    setWorkspaceDialog({ type: "delete-project", projectId });
  }

  function openRenameConversationDialog(conversationId: string) {
    rememberMenuOrigin("conversation", conversationId);
    setWorkspaceDialog({ type: "rename-conversation", conversationId });
  }

  function openDeleteConversationDialog(conversationId: string) {
    if (pendingGenerationRef.current === conversationId || requestRef.current?.conversationId === conversationId || (responding && activeConversationId === conversationId)) {
      showAnnouncement("请先停止当前回复，再删除对话");
      return;
    }
    rememberMenuOrigin("conversation", conversationId);
    setWorkspaceDialog({ type: "delete-conversation", conversationId });
  }

  function createStandaloneConversation(name: string) {
    createConversation(name);
  }

  function createConversation(name: string, projectId?: string) {
    if (projectId && !projects.some((project) => project.id === projectId))
      return;
    const id = createLocalId("conversation");
    const nextConversation: TongpinAIConversation = {
      id,
      projectId,
      title: name,
      timeLabel: "刚刚",
      messages: [],
    };
    const pendingDraftKey = projectId
      ? `new-project-conversation:${projectId}`
      : "new-conversation";
    setDrafts((current) => {
      if (!(pendingDraftKey in current)) return current;
      const next = { ...current, [id]: current[pendingDraftKey] };
      delete next[pendingDraftKey];
      return next;
    });
    setDraftAttachments(current => {
      if (!(pendingDraftKey in current)) return current;
      const next = { ...current, [id]: current[pendingDraftKey] }; delete next[pendingDraftKey]; return next;
    });
    setConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(id);
    setActiveProjectId(projectId ?? null);
    setView("chat");
    setArtifactOpen(false);
    setWorkspaceDialog(null);
    if (window.matchMedia("(max-width: 760px)").matches)
      setSidebarCollapsed(true);
    setComposerFocusRequest((current) => current + 1);
  }

  function createProject(name: string) {
    const id = createLocalId("project");
    setProjects((current) => [
      { id, title: name, timeLabel: "刚刚" },
      ...current,
    ]);
    setActiveProjectId(id);
    setActiveConversationId(null);
    setView("project");
    setArtifactOpen(false);
    setWorkspaceDialog(null);
    if (window.matchMedia("(max-width: 760px)").matches)
      setSidebarCollapsed(true);
    window.requestAnimationFrame(() =>
      document.getElementById("tp-ai-project-title")?.focus(),
    );
    showAnnouncement("项目“" + name + "”已创建");
  }

  function createProjectConversation(projectId: string, name: string) {
    createConversation(name, projectId);
  }

  function renameProject(projectId: string, name: string) {
    setProjects((current) =>
      current.map((item) =>
        item.id === projectId ? { ...item, title: name } : item,
      ),
    );
    closeWorkspaceDialog();
  }

  function deleteProject(projectId: string) {
    const movedConversations = conversations.filter(
      (conversation) => conversation.projectId === projectId,
    );
    setProjects((current) => current.filter((item) => item.id !== projectId));
    setDrafts((current) => {
      const next = { ...current };
      delete next[`new-project-conversation:${projectId}`];
      return next;
    });
    setDraftAttachments(current => { const next = { ...current }; delete next[`new-project-conversation:${projectId}`]; return next; });
    setConversations((current) =>
      current.map((conversation) =>
        conversation.projectId === projectId
          ? { ...conversation, projectId: undefined }
          : conversation,
      ),
    );
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.projectId === projectId
          ? { ...artifact, projectId: undefined }
          : artifact,
      ),
    );
    if (activeProjectId === projectId) {
      setActiveProjectId(null);
      setView("chat");
      setArtifactOpen(false);
      // An open conversation survives its project and keeps its draft.
      if (!activeConversation)
        setActiveConversationId(movedConversations[0]?.id ?? null);
    }
    closeWorkspaceDialog();
    showAnnouncement(
      movedConversations.length > 0
        ? "项目已删除，" + movedConversations.length + " 个对话已移入普通对话"
        : "项目已删除",
    );
  }

  function renameConversation(conversationId: string, name: string) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title: name }
          : conversation,
      ),
    );
    closeWorkspaceDialog();
  }

  async function deleteConversation(conversationId: string) {
    if (pendingGenerationRef.current === conversationId || requestRef.current?.conversationId === conversationId) {
      showAnnouncement("请先等待当前请求完成，再删除对话"); return;
    }
    if (!liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId)) return;
    deletingConversationRef.current.add(conversationId);
    // Register before I/O so leaving AI or signing out waits for the entire deletion.
    const task = Promise.resolve().then(async () => {
      try {
        const assetIds = workspaceRef.current.artifacts.filter(item => item.conversationId === conversationId).flatMap(item => Array.isArray(item.data?.images) ? item.data.images.flatMap(image => image && typeof image === "object" && !Array.isArray(image) && typeof image.assetId === "string" && !image.deleted ? [image.assetId] : []) : []);
        for (const assetId of new Set(assetIds)) {
          if (!mountedRef.current) return false;
          try { await api(`/api/ai/assets/${encodeURIComponent(assetId)}`, { method: "DELETE", headers: { "X-Tongpin-Account": user.id } }); }
          catch (error) { if (!(error instanceof ApiRequestError && error.code === "AI_ASSET_NOT_FOUND")) throw error; }
        }
        if (!mountedRef.current) return false;
        const latest = workspaceRef.current;
        const next = withoutConversation(latest, conversationId);
        // Invalidate stale send/retry callbacks before releasing the deletion lock.
        workspaceRef.current = next;
        setConversations(next.conversations);
        setArtifacts(next.artifacts);
        setDrafts(next.drafts);
        setDraftAttachments(next.draftAttachments);
        if (latest.activeConversationId === conversationId) {
          setActiveConversationId(next.activeConversationId);
          setActiveProjectId(next.activeProjectId);
          setView(next.view);
          setArtifactOpen(false);
          setActiveArtifactId(null);
        }
        for (const [messageId, retry] of retryRequestsRef.current) {
          if (retry.conversationId === conversationId) retryRequestsRef.current.delete(messageId);
        }
        for (const message of latest.conversations.find(item => item.id === conversationId)?.messages ?? []) completedResponsesRef.current.delete(message.id);
        if (latest.workspaceDialog?.type === "delete-conversation" && latest.workspaceDialog.conversationId === conversationId) closeWorkspaceDialog();
        const saved = await persistenceRef.current.saveNow(withoutConversation(persistentStateRef.current, conversationId));
        if (mountedRef.current) showAnnouncement(saved ? "对话已删除" : "对话已移除，请重试保存以同步删除");
        return saved;
      } catch (error) {
        if (mountedRef.current) showAnnouncement(error instanceof Error ? error.message : "图片删除失败，请重试");
        return false;
      }
    });
    deletionTasksRef.current.set(conversationId, task);
    try { await task; }
    finally { deletingConversationRef.current.delete(conversationId); deletionTasksRef.current.delete(conversationId); }
  }

  function moveConversation(conversationId: string, projectId?: string) {
    const conversation = conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation || conversation.projectId === projectId) return;
    if (projectId && !projects.some((project) => project.id === projectId))
      return;
    setConversations((current) =>
      moveConversationToProject(current, projects, conversationId, projectId),
    );
    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.conversationId === conversationId
          ? { ...artifact, projectId }
          : artifact,
      ),
    );
    if (activeConversationId === conversationId)
      setActiveProjectId(projectId ?? null);
    showAnnouncement(projectId ? "对话已移入项目" : "对话已移入普通对话");
  }

  function selectProject(projectId: string) {
    if (!projects.some((project) => project.id === projectId)) return;
    setActiveProjectId(projectId);
    setActiveConversationId(null);
    setView("project");
    setArtifactOpen(false);
  }

  function selectConversation(conversationId: string) {
    const conversation = conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;
    setActiveConversationId(conversationId);
    setActiveProjectId(conversation.projectId ?? null);
    setView("chat");
    setArtifactOpen(false);
  }

  function updateReply(conversationId: string, messageId: string, patch: Parameters<typeof replaceChatMessage>[3]) {
    setConversations((current) => replaceChatMessage(current, conversationId, messageId, patch));
  }

  function displayReply(conversationId: string, messageId: string, response: AiChatResponse) {
    retryRequestsRef.current.delete(messageId);
    completedResponsesRef.current.set(messageId, completedReply(response));
    const finish = () => {
      if (typingRef.current) window.clearTimeout(typingRef.current.timer);
      typingRef.current = null;
      if (!mountedRef.current) return;
      updateReply(conversationId, messageId, completedReply(response));
      setResponding(false);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    setResponsePhase("typing");
    const characters = Array.from(response.content);
    const step = Math.max(2, Math.ceil(characters.length / 200));
    let shown = 0;
    const tick = () => {
      if (!mountedRef.current) return;
      shown = Math.min(shown + step, characters.length);
      if (shown === characters.length) { finish(); return; }
      updateReply(conversationId, messageId, { content: characters.slice(0, shown).join(""), status: "typing", model: response.model, usage: response.usage });
      typingRef.current = { timer: window.setTimeout(tick, 24), finish };
    };
    tick();
  }

  function acceptGeneration(conversationId: string, messageId: string, response: AiChatResponse | AiImageResponse) {
    const latestConversation = liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId);
    if (!latestConversation) { setResponding(false); return; }
    const imageResult = "images" in response;
    const presentation = !imageResult ? response.presentation : undefined;
    if (imageResult || presentation) {
      const artifactId = `artifact-${response.requestId}`;
      const artifact: TongpinAIArtifact = {
        id: artifactId, conversationId,
        projectId: latestConversation.projectId,
        title: presentation?.title ?? "生成的图片", kind: imageResult ? "图片" : "PPT", updatedLabel: "刚刚",
        summary: presentation?.subtitle ?? (imageResult ? "图片已生成" : "演示文稿已生成"),
        sections: presentation?.slides.map(slide => ({ heading: slide.title, lines: slide.bullets })) ?? [],
        data: imageResult ? { images: response.images.map(item => ({ ...item })) } : { presentation: { ...presentation!, slides: presentation!.slides.map(slide => ({ ...slide })) } },
      };
      setArtifacts(current => [artifact, ...current.filter(item => item.id !== artifactId)]);
      updateReply(conversationId, messageId, { artifactId });
    }
    setAiStatus(current => current ? { ...current, quota: response.quota } : current);
    displayReply(conversationId, messageId, imageResult ? { ...response, content: "图片已生成，点击下方成果查看和下载。" } : response);
  }

  async function performChat(conversationId: string, messageId: string, request: GenerationRequest) {
    if (requestRef.current || typingRef.current) return;
    if (!mountedRef.current || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) {
      if (mountedRef.current) setResponding(false);
      return;
    }
    const controller = new AbortController();
    requestRef.current = { controller, conversationId, messageId, request };
    retryRequestsRef.current.set(messageId, { conversationId, request });
    setResponding(true);
    setResponsePhase("waiting");
    updateReply(conversationId, messageId, { content: "", status: "thinking" });
    try {
      const response = await api<AiChatResponse | AiImageResponse>("prompt" in request ? "/api/ai/images" : "/api/ai/chat", {
        method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(request), signal: controller.signal,
      }, 130_000);
      if (!mountedRef.current || controller.signal.aborted) return;
      acceptGeneration(conversationId, messageId, response);
    } catch (error) {
      if (!mountedRef.current) return;
      const interrupted = controller.signal.aborted;
      if (!canRecoverChatRequest(error instanceof ApiRequestError ? error.code : undefined, interrupted)) {
        retryRequestsRef.current.delete(messageId);
      }
      updateReply(conversationId, messageId, { status: "error", content: interrupted
        ? "已停止等待。请求可能仍在处理，实际扣额请查看 Token 使用详情。"
        : error instanceof ApiRequestError && error.code === "NETWORK_UNAVAILABLE"
          ? "连接中断，暂时没有收到完整回复。可重新获取同一请求，避免重复发送。"
          : error instanceof Error ? error.message : "暂时无法获取回复，请稍后重试。" });
      setResponding(false);
    } finally {
      if (requestRef.current?.controller === controller) requestRef.current = null;
      if (mountedRef.current) void refreshStatus();
    }
  }

  async function sendMessage() {
    if (!persona.profile.onboardingComplete || !draft.trim() || responding || pendingGenerationRef.current || requestRef.current || quotaInsufficient || !serviceConnected || connectionError) return;
    if (activeConversationId && !liveConversation(workspaceRef.current, deletingConversationRef.current, activeConversationId)) {
      showAnnouncement("此对话正在删除或已被删除，请选择其他对话"); return;
    }
    if (persistence.status === "conflict" || persistence.status === "error") { showAnnouncement("请先完成记录同步，再发送消息"); return; }
    if (composerTool === "image" && (!aiStatus?.imageEnabled || attachments.length || webSearch)) {
      showAnnouncement(!aiStatus?.imageEnabled ? "请管理员先配置图片模型" : "图片生成暂不支持附件和联网，请先移除或切回对话"); return;
    }
    if (webSearch && !aiStatus?.webSearchEnabled) { showAnnouncement("请关闭联网搜索，或联系管理员启用"); return; }
    const content = draft.trim();
    const conversationId = activeConversation?.id ?? createLocalId("conversation");
    const messageId = createLocalId("assistant");
    const requestId = crypto.randomUUID();
    const messages = [...(activeConversation?.messages ?? []), { id: createLocalId("user"), role: "user" as const, content, time: currentTimeLabel(), ...(attachments.length ? { attachments } : {}) }];
    const documents = [...(activeProject?.contextDocuments ?? []), ...attachments];
    let request: GenerationRequest;
    try {
      // Prior attachments stay as untrusted source text for follow-up questions.
      const currentDocuments = new Map(documents.map(item => [item.id, item]));
      for (const message of messages) for (const item of message.attachments ?? []) currentDocuments.set(item.id, item);
      const documentPayload = [...currentDocuments.values()].map(item => ({ name: item.name, text: item.content, mediaType: item.mimeType }));
      if (composerTool !== "image") validateAttachments(documentPayload);
      request = composerTool === "image" ? { requestId, prompt: content } : {
        ...buildChatRequest(requestId, mode, messages), skillIds: skillRequestIds(enabledSkillIds),
        projectContext: activeProject?.instructions || undefined,
        attachments: documentPayload, outputFormat: composerTool === "presentation" ? "presentation" : "text", webSearch,
      };
    } catch (error) { showAnnouncement(error instanceof Error ? error.message : "内容超出限制"); return; }
    const conversation: TongpinAIConversation = {
      ...(activeConversation ?? { id: conversationId, projectId: activeProject?.id, title: Array.from(content.split("\n")[0]).slice(0, 28).join("") }),
      timeLabel: "刚刚", messages: [...messages, { id: messageId, requestId, role: "assistant", content: "", status: "thinking", time: currentTimeLabel() }],
    };
    const nextConversations = [conversation, ...conversations.filter(item => item.id !== conversationId)];
    pendingGenerationRef.current = conversationId;
    pendingCancelledRef.current = false;
    setConversations(nextConversations);
    setActiveConversationId(conversationId);
    setView("chat");
    updateDraft("");
    setDraftAttachments(current => ({ ...current, [draftKey]: [] }));
    setResponding(true);
    const saved = await persistence.saveNow({ ...persistentState, conversations: nextConversations,
      activeConversationId: conversationId, view: "chat", drafts: { ...drafts, [draftKey]: "" },
      draftAttachments: { ...draftAttachments, [draftKey]: [] },
    });
    if (!mountedRef.current) { pendingGenerationRef.current = null; return; }
    if (pendingCancelledRef.current) {
      pendingGenerationRef.current = null; setResponding(false);
      updateReply(conversationId, messageId, { status: "stopped", content: "已取消发送，本次未调用模型。" }); return;
    }
    if (!saved) {
      setResponding(false);
      retryRequestsRef.current.set(messageId, { conversationId, request });
      updateReply(conversationId, messageId, { status: "error", content: "记录尚未保存，请恢复同步后重新获取回复。本次尚未调用模型。" });
      pendingGenerationRef.current = null;
      return;
    }
    if (!workspaceRef.current.conversations.some(item => item.id === conversationId && item.messages.some(message => message.id === messageId))) {
      pendingGenerationRef.current = null; setResponding(false); return;
    }
    try { await performChat(conversationId, messageId, request); }
    finally { pendingGenerationRef.current = null; }
  }

  async function retryReply(messageId: string) {
    if (responding || requestRef.current || pendingGenerationRef.current) return;
    const retry = retryRequestsRef.current.get(messageId);
    if (retry) {
      if (!liveConversation(workspaceRef.current, deletingConversationRef.current, retry.conversationId, messageId)) return;
      if (persistence.status === "error" || persistence.status === "conflict") { showAnnouncement("请先恢复记录同步"); return; }
      pendingGenerationRef.current = retry.conversationId; pendingCancelledRef.current = false; setResponding(true);
      try {
        const saved = await persistence.flushSaved();
        if (saved && mountedRef.current && !pendingCancelledRef.current) await performChat(retry.conversationId, messageId, retry.request);
        else setResponding(false);
      } finally { pendingGenerationRef.current = null; }
      return;
    }
    const conversation = workspaceRef.current.conversations.find(item => item.messages.some(message => message.id === messageId));
    const message = conversation?.messages.find(item => item.id === messageId);
    if (!conversation || !message?.requestId || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversation.id, messageId)) return;
    setResponding(true);
    try {
      const cached = await api<{ status: string; result?: AiChatResponse; imageResult?: AiImageResponse; error?: { message: string } }>(`/api/ai/requests/${encodeURIComponent(message.requestId)}`, { headers: { "X-Tongpin-Account": user.id } });
      if (!mountedRef.current) return;
      if (cached.result || cached.imageResult) acceptGeneration(conversation.id, messageId, (cached.result ?? cached.imageResult)!);
      else { updateReply(conversation.id, messageId, { status: "error", content: cached.error?.message ?? "请求仍在处理，请稍后重新获取。不会再次调用模型。" }); setResponding(false); }
    } catch (error) { if (mountedRef.current) { showAnnouncement(error instanceof Error ? error.message : "无法获取上次结果"); setResponding(false); } }
  }

  function stopResponse() {
    if (typingRef.current) { typingRef.current.finish(); return; }
    if (pendingGenerationRef.current && !requestRef.current) { pendingCancelledRef.current = true; return; }
    requestRef.current?.controller.abort();
  }

  function openArtifact(artifactId: string) {
    const artifact = artifactById.get(artifactId);
    if (!artifact || artifact.conversationId !== activeConversationId) return;
    setActiveArtifactId(artifactId);
    setArtifactOpen(true);
  }

  function toggleSkill(skillId: string) {
    try { setEnabledSkillIds(selectSkill(enabledSkillIds, skillId)); }
    catch (error) { showAnnouncement(error instanceof Error ? error.message : "无法选择技能"); }
  }

  function openDemoAction(action: TongpinAIDemoAction) {
    setComposerTool(action === "ppt" ? "presentation" : "image");
  }

  function openSkills() {
    setView("skills");
    setArtifactOpen(false);
  }

  function returnFromSkills() {
    setView(!activeConversation && activeProject ? "project" : "chat");
  }

  const dialogProject =
    workspaceDialog && "projectId" in workspaceDialog
      ? (projects.find((project) => project.id === workspaceDialog.projectId) ??
        null)
      : null;
  const dialogConversation =
    workspaceDialog && "conversationId" in workspaceDialog
      ? (conversations.find(
          (conversation) => conversation.id === workspaceDialog.conversationId,
        ) ?? null)
      : null;
  const otherProjectNames = projects
    .filter((project) => project.id !== dialogProject?.id)
    .map((project) => project.title);

  return (
    <section
      className={
        "tp-ai-page" +
        (artifactOpen && activeArtifact && view === "chat"
          ? " has-preview"
          : "") +
        (sidebarCollapsed ? " is-sidebar-collapsed" : "")
      }
      aria-label="同频 AI 成员工作台"
    >
      {(persistence.status === "error" || persistence.status === "conflict") && <div className="tp-ai-sync-error" role="alert">
        <span>{persistence.error}</span>
        {persistence.status === "error" && <button type="button" onClick={persistence.retry}>重试保存</button>}
        <button type="button" onClick={exportWorkspace}>导出当前内容</button>
        {persistence.status === "conflict" && <button type="button" onClick={() => {
          if (window.confirm("请先导出当前内容。重新加载后将显示云端记录，是否继续？")) window.location.reload();
        }}>重新加载云端</button>}
      </div>}
      <TongpinAISidebar
        activeConversationId={activeConversationId}
        activeProjectId={activeProjectId}
        conversations={conversations}
        projects={projects}
        skillCount={TONGPIN_AI_SKILLS.length}
        usage={usage}
        quotaSynced={aiStatus !== null}
        onRefreshUsage={refreshStatus}
        user={user}
        view={view}
        collapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        onDeleteProject={openDeleteProjectDialog}
        onNewConversation={() => openNewConversationDialog()}
        onNewProject={openNewProjectDialog}
        onNewProjectConversation={openNewConversationDialog}
        onOpenSkills={openSkills}
        onRenameProject={openRenameProjectDialog}
        onRenameConversation={openRenameConversationDialog}
        onDeleteConversation={openDeleteConversationDialog}
        onMoveConversation={moveConversation}
        onSelectConversation={selectConversation}
        onSelectProject={selectProject}
      />

      {view === "skills" ? (
        <SkillMarketplace
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          enabledSkillIds={enabledSkillIds}
          notificationUnread={notificationToolbar?.unread ?? 0}
          onBackToChat={returnFromSkills}
          onOpenNotifications={notificationToolbar?.openNotificationDrawer}
          onToggleSkill={toggleSkill}
        />
      ) : view === "project" && activeProject ? (
        <ProjectWorkspaceEmpty
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          conversationCount={activeProjectConversations.length}
          conversations={activeProjectConversations}
          notificationUnread={notificationToolbar?.unread ?? 0}
          project={activeProject}
          onNewConversation={() => openNewConversationDialog(activeProject.id)}
          onOpenNotifications={notificationToolbar?.openNotificationDrawer}
          onSelectConversation={selectConversation}
          onRenameProject={() => openRenameProjectDialog(activeProject.id)}
          onDeleteProject={() => openDeleteProjectDialog(activeProject.id)}
          onUpdateContext={(instructions, contextDocuments) => setProjects(current => current.map(project => project.id === activeProject.id ? { ...project, instructions, contextDocuments } : project))}
        />
      ) : (
        <ChatWorkspace
          assistantName={persona.profile.name || "同频 AI"}
          onEditPersona={() => setPersonaSettingsOpen(true)}
          artifactById={artifactById}
          composerFocusRequest={composerFocusRequest}
          conversationId={activeConversation?.id}
          conversationTitle={activeConversation?.title}
          draft={draft}
          attachments={attachments}
          onAddFiles={addFiles}
          onRemoveAttachment={index => setDraftAttachments(current => ({ ...current, [draftKey]: attachments.filter((_, itemIndex) => itemIndex !== index) }))}
          composerTool={composerTool}
          onComposerToolChange={setComposerTool}
          imageEnabled={aiStatus?.imageEnabled === true}
          webSearchEnabled={aiStatus?.webSearchEnabled === true}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
          enabledSkills={TONGPIN_AI_SKILLS.filter((skill) =>
            enabledSkillIds.has(skill.id),
          )}
          messages={activeConversation?.messages ?? []}
          mode={mode}
          notificationUnread={notificationToolbar?.unread ?? 0}
          projectTitle={activeProject?.title}
          quotaInsufficient={quotaInsufficient}
          responding={responding}
          responsePhase={responsePhase}
          connectionLoading={connectionLoading}
          connectionError={connectionError}
          onRefreshConnection={() => void refreshStatus()}
          serviceConnected={serviceConnected}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenSkills={openSkills}
          onDraftChange={updateDraft}
          onDemoAction={openDemoAction}
          onModeChange={setMode}
          onOpenNotifications={notificationToolbar?.openNotificationDrawer}
          onOpenArtifact={openArtifact}
          onSubmit={sendMessage}
          onStop={stopResponse}
          onRetry={retryReply}
          retryableMessageIds={new Set([...retryRequestsRef.current.keys(), ...conversations.flatMap(item => item.messages.filter(message => message.status === "error" && message.requestId).map(message => message.id))])}
        />
      )}

      {view === "chat" && artifactOpen && activeArtifact ? (
        <ArtifactPreview
          artifact={activeArtifact}
          onClose={() => setArtifactOpen(false)}
          onImageDeleted={assetId => setArtifacts(current => current.map(artifact => !Array.isArray(artifact.data?.images) ? artifact : { ...artifact, data: { ...artifact.data, images: artifact.data.images.map(image => image && typeof image === "object" && !Array.isArray(image) && image.assetId === assetId ? { ...image, deleted: true } : image) } }))}
        />
      ) : view === "chat" && latestConversationArtifact ? (
        <button
          type="button"
          className="tp-ai-preview-reopen"
          aria-label={"重新打开成果：" + latestConversationArtifact.title}
          onClick={() => openArtifact(latestConversationArtifact.id)}
        >
          <PanelRightOpen size={18} />
          <span>打开成果</span>
          <FileText size={15} />
        </button>
      ) : null}

      {workspaceDialog?.type === "new-project" ? (
        <TongpinAINameDialog
          kind="project"
          title="是否新建项目？"
          description="输入项目名称，确认后创建。"
          label="项目名称"
          confirmLabel="确认新建"
          unavailableNames={projects.map((project) => project.title)}
          onCancel={closeWorkspaceDialog}
          onConfirm={createProject}
        />
      ) : workspaceDialog?.type === "new-conversation" ? (
        <TongpinAINameDialog
          kind="conversation"
          title={
            dialogProject
              ? "在“" + dialogProject.title + "”中新建对话"
              : "新建普通对话"
          }
          description=""
          label="对话名称"
          confirmLabel="创建对话"
          onCancel={closeWorkspaceDialog}
          onConfirm={(name) => {
            if (dialogProject)
              createProjectConversation(dialogProject.id, name);
            else createStandaloneConversation(name);
          }}
        />
      ) : workspaceDialog?.type === "rename-project" && dialogProject ? (
        <TongpinAINameDialog
          kind="project"
          title="重命名项目"
          description=""
          label="项目名称"
          initialValue={dialogProject.title}
          confirmLabel="保存名称"
          unavailableNames={otherProjectNames}
          onCancel={closeWorkspaceDialog}
          onConfirm={(name) => renameProject(dialogProject.id, name)}
        />
      ) : workspaceDialog?.type === "delete-project" && dialogProject ? (
        <TongpinAIProjectDeleteDialog
          projectTitle={dialogProject.title}
          conversationCount={
            conversations.filter(
              (conversation) => conversation.projectId === dialogProject.id,
            ).length
          }
          onCancel={closeWorkspaceDialog}
          onConfirm={() => deleteProject(dialogProject.id)}
        />
      ) : workspaceDialog?.type === "rename-conversation" &&
        dialogConversation ? (
        <TongpinAINameDialog
          kind="conversation"
          title="重命名对话"
          description=""
          label="对话名称"
          initialValue={dialogConversation.title}
          confirmLabel="保存名称"
          onCancel={closeWorkspaceDialog}
          onConfirm={(name) => renameConversation(dialogConversation.id, name)}
        />
      ) : workspaceDialog?.type === "delete-conversation" &&
        dialogConversation ? (
        <TongpinAIConversationDeleteDialog
          conversationTitle={dialogConversation.title}
          onCancel={closeWorkspaceDialog}
          onConfirm={() => deleteConversation(dialogConversation.id)}
        />
      ) : null}

      {announcement && (
        <div className="tp-ai-toast" role="status">
          <Info size={17} />
          <span>{announcement}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setAnnouncement("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {(!persona.profile.onboardingComplete || personaSettingsOpen) && <PersonaSetup
        key={persona.revision} snapshot={persona} accountId={user.id}
        onClose={() => setPersonaSettingsOpen(false)}
        onSaved={next => { onPersonaSaved(next); setPersonaSettingsOpen(false); if (next.profile.onboardingComplete) showAnnouncement(`已记住，我叫${next.profile.name}。以后会按照你的偏好与你合作。`); }}
      />}
    </section>
  );
}

export default TongpinAIPage;
