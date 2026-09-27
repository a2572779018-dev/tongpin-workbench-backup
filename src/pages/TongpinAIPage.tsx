import { FileText, Info, PanelRightOpen, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiRequestError } from "../lib/api";
import { readAiChatStream } from "../lib/aiRunStream";
import { getComputerUseBridge } from "../lib/computerUseBridge";
import { shouldRecoverReply, waitForReply } from "../features/tongpin-ai/waitForReply";
import { useAiAvailability } from "../features/tongpin-ai/useAiAvailability";
import { AiAvailabilityNotice } from "../features/tongpin-ai/AiAvailabilityNotice";
import type { AiRequestResult } from "../../shared/ai";
import type { AiChatPreflight, AiChatRequest, AiChatResponse, AiHarnessTrace, AiImageRequest, AiImageResponse, AiStatus, AiToolPlan } from "../../shared/ai";
import type { AiVideoList } from "../../shared/aiVideo";
import { aiVideoReferenceFingerprint } from "../../shared/aiVideoReferences";
import { ChatPreflightGate, preflightNotice, sameSendContext, withPreparedChatSend } from "../features/tongpin-ai/chatPreflight";
import type { AiWorkspaceDocument, AiWorkspaceSaveRequest, AiWorkspaceSnapshot, AiWorkspaceVideoDraftSettings } from "../../shared/aiWorkspace";
import { useWorkspacePersistence } from "../features/tongpin-ai/useWorkspacePersistence";
import { workspaceSaveTimeoutMs } from "../features/tongpin-ai/workspaceSync";
import { liveConversation, withoutConversation } from "../features/tongpin-ai/conversationOperations";
import { registerAiLeaveGuard } from "../features/tongpin-ai/workspaceLeaveGuard";
import { PersonaSetup } from "../features/tongpin-ai/PersonaSetup";
import { AiAccessState } from "../features/tongpin-ai/AiAccessState";
import { loadAiEntry, type AiEntry } from "../features/tongpin-ai/loadAiEntry";
import type { AiPersonaSnapshot } from "../../shared/aiPersona";
import type { ComputerUseProbeResult } from "../../shared/computerUse";
import { computerOperationIntent } from "../../shared/computerAgent";
import { documentAttachments, ensureAttachmentWorkspaceCapacity, extractAttachment, workspaceAttachment, validateAttachments, WorkspaceCapacityError } from "../features/tongpin-ai/attachments";
import { selectSkill } from "../features/tongpin-ai/skills";
import { assertGeneratedMediaCapacity, toolAttachmentContext } from "../features/tongpin-ai/attachmentContext";
import { draftsWithoutComputerRequests, mentionedCapabilityRequest } from "../features/tongpin-ai/skillMentions";
import { computerUseConversationRequestMessage } from "../features/tongpin-ai/computerUseFlow";
import { ComputerRunPanel } from "../features/tongpin-ai/ComputerRunPanel";
import { buildChatRequest, canRecoverChatRequest, completedReply, interruptedChatRequests, recoverInterruptedMessages, replaceChatMessage } from "../features/tongpin-ai/chatRequests";
import { conversationsForPersistence } from "../features/tongpin-ai/chatPerformance";
import { computerTierNotice } from "../features/tongpin-ai/computerTier";
import { AI_DOWNLOAD_FEEDBACK_EVENT, saveBlobWithFeedback, type AiDownloadFeedback } from "../features/tongpin-ai/downloadFeedback";
import { videoReferenceDraftAttachments, videoReferencesFromAttachments } from "../features/tongpin-ai/videoReferenceAttachments";
import { imageReferencesForGeneration } from "../features/tongpin-ai/imageReferenceAttachments";
import { generatedImageEditReferenceIds } from "../features/tongpin-ai/generatedImageEditReference";
import { generatedVideoReference, generatedVideoReferenceCandidates, videoReferenceUploadBody } from "../features/tongpin-ai/generatedVideoReference";
import { generatedMediaForFollowup, generatedMediaForMixedFollowup, readGeneratedMedia } from "../features/tongpin-ai/generatedMediaContext";
import { readGeneratedImageSelection, type GeneratedImageSelection } from "../features/tongpin-ai/generatedImageSelection";
import { persistedVideoChatRequest, type VideoChatRequest } from "../features/tongpin-ai/videoChat";
import { explicitVideoChoice, naturalVideoRequest } from "../features/tongpin-ai/naturalVideoRequest";
import { parseMediaTaskResponse, type MediaTaskRun } from "../features/tongpin-ai/mediaTaskClient";
import { preserveVideoClarificationDraft } from "../features/tongpin-ai/videoDraftRecovery";
import { hasConversationActivity } from "../features/tongpin-ai/conversationActivity";
import { captureSubmission, mergeContinuation, type SubmissionSnapshot } from "../features/tongpin-ai/submissionSnapshot";
import { conversationTaskStatus, messageTaskStatus, readSeenResults, saveSeenResults } from "../features/tongpin-ai/conversationTaskStatus";
import { mediaCacheScope, videoBlobCache } from "../features/tongpin-ai/mediaCache";
import { sameHarnessTrace } from "../features/tongpin-ai/runTracePolling";
import { useNotificationToolbar } from "../components/NotificationToolbarContext";
import { appendDraftText, awaitingUserConfirmation, latestAssistantMessage, steerDeliveryTarget, steerRunActive, supplementBlockReason } from "../features/tongpin-ai/composerSteer";
import { runGuidanceClient, useSteerController, type SteerSendResult } from "../features/tongpin-ai/steerController";
import { ArtifactPreview } from "../features/tongpin-ai/ArtifactPreview";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, settleReplyProcess, withReplyProcessTool, type AiReplyProcessLive } from "../../shared/aiReplyProcess";
import { requestMultiAgentStop } from "../features/tongpin-ai/multiAgentClient";
import { ChatWorkspace } from "../features/tongpin-ai/ChatWorkspace";
import { TongpinAIWorkspaceV2 } from "../features/tongpin-ai/TongpinAIWorkspaceV2";
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
import "../features/tongpin-ai/ai-refinements.css";
import "../features/tongpin-ai/workspace-storage.css";
import { WorkspaceStorageRelief } from "../features/tongpin-ai/WorkspaceStoragePanel";
import { attachOpenSquillaRoute, warmOpenSquillaRouter } from "../features/tongpin-ai/opensquilla/desktopBridge";
import { conversationExportFilename, conversationExportJson, isWorkspaceSpaceRejection, largestWorkspaceConversations } from "../features/tongpin-ai/workspaceStorage";

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
  const [entry, setEntry] = useState<AiEntry | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setEntry(null);
    void loadAiEntry(api, user.id, controller.signal)
      .then(next => { if (!controller.signal.aborted) setEntry(next); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "工作台暂时无法加载"); });
    return () => controller.abort();
  }, [api, user.id, attempt]);
  if (!entry || entry.kind === "locked") return <AiAccessState name={user.name} loading={!entry && !error} error={error} locked={entry?.kind === "locked"} onRetry={() => setAttempt(value => value + 1)} />;
  // Do not initialize hidden GPU effects, chat hydration or autosaving behind setup.
  if (entry.kind === "onboarding") return <section className="tp-ai-entry tp-ai-entry--setup"><PersonaSetup
    key={entry.persona.revision} snapshot={entry.persona} accountId={user.id}
    onSaved={() => setAttempt(value => value + 1)}
  /></section>;
  if (entry.kind === "ready-v2") return <TongpinAIWorkspaceV2 user={user} initial={entry.workspace} status={entry.status} persona={entry.persona} />;
  return <TongpinAIWorkspace user={user} initialSnapshot={entry.workspace} initialStatus={entry.status} persona={entry.persona}
    onPersonaSaved={persona => setEntry(current => current?.kind === "ready" ? { ...current, persona } : current)} />;
}

type GenerationRequest = AiChatRequest | AiImageRequest;
type TaskContinuation = { conversationId: string; messageId: string; originalPrompt: string; snapshot: SubmissionSnapshot;
  /** A text turn's first save, still in flight. sendMessage overlaps its read-only
   * preflight with it and awaits it before persisting the reply or calling a model. */
  recorded?: Promise<boolean>;
  /** Steer follow-up: text typed while the previous reply ran (always a text turn). */
  supplement?: boolean };
type ComputerUseRequest = {
  id: string;
  conversationId: string;
  originalPrompt: string;
  /** Dispatch summary of the chat turn (natural-language entry only). */
  contextHint?: string;
  mode: TongpinAIMode;
  hasResult: boolean;
};

function TongpinAIWorkspace({ user, initialSnapshot, initialStatus, persona, onPersonaSaved }: {
  user: User; initialSnapshot: AiWorkspaceSnapshot; initialStatus: AiStatus; persona: AiPersonaSnapshot; onPersonaSaved: (value: AiPersonaSnapshot) => void;
}) {
  const { api, session } = useAuth();
  const notificationToolbar = useNotificationToolbar();
  const [initialSession] = useState(() => hydrateWorkspace(initialSnapshot.state));
  const [view, setView] = useState<TongpinAIWorkspaceView>(initialSession.view);
  const [personaSettingsOpen, setPersonaSettingsOpen] = useState(false);
  const [mode, setMode] = useState<TongpinAIMode>(initialSession.mode);
  // Desktop only: load OpenSquilla's quick-tier router before the first quick send.
  useEffect(() => { if (mode === "quick") warmOpenSquillaRouter(); }, [mode]);
  const [conversations, setConversations] = useState<TongpinAIConversation[]>(
    () => recoverInterruptedMessages(initialSession.conversations),
  );
  const [interruptedRequests] = useState(() => interruptedChatRequests(initialSession.conversations));
  const [projects, setProjects] = useState<TongpinAIProject[]>(
    initialSession.projects,
  );
  const [artifacts, setArtifacts] = useState<TongpinAIArtifact[]>(
    initialSession.artifacts,
  );
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(initialStatus);
  const [connectionError, setConnectionError] = useState("");
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [conversationActivity, setConversationActivity] = useState<Record<string, { messageId: string; phase: "waiting" | "typing" }>>({});
  const [seenResults, setSeenResults] = useState(() => readSeenResults(user.id));
  // Live deltas are transient and excluded from workspace serialization. Only
  // the final/partial result enters durable conversation state.
  const [streamReplies, setStreamReplies] = useState<Record<string, { content: string; analysisSummary: string; liveProcess: AiReplyProcessLive }>>({});
  const [checkingQuota, setCheckingQuota] = useState(false);
  const [computerProbe, setComputerProbe] = useState<ComputerUseProbeResult | null>(null);
  const [computerRequest, setComputerRequest] = useState<ComputerUseRequest | null>(null);
  const [preflightGate] = useState(() => new ChatPreflightGate());
  const [budgetNotice, setBudgetNotice] = useState<{ context: readonly unknown[]; result: AiChatPreflight } | null>(null);
  const requestRef = useRef(new Map<string, { controller: AbortController; messageId: string }>());
  const retryRequestsRef = useRef(new Map<string, { conversationId: string; request: GenerationRequest }>());
  const submissionSnapshotsRef = useRef(new Map<string, SubmissionSnapshot>());
  const pendingGenerationRef = useRef(new Set<string>());
  const pendingCancelledRef = useRef(new Set<string>());
  const imageSelectionBusyRef = useRef(new Set<string>());
  const draftConversationIdsRef = useRef(new Map<string, string>());
  const fileImportRef = useRef(new Set<string>());
  const deletingConversationRef = useRef(new Set<string>());
  const deletionTasksRef = useRef(new Map<string, Promise<boolean>>());
  const typingRef = useRef(new Map<string, { timer: number; messageId: string; finish: () => void }>());
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
  const [videoDraftSettings, setVideoDraftSettings] = useState<Record<string, AiWorkspaceVideoDraftSettings>>(initialSession.videoDraftSettings ?? {});
  const [composerTool, setComposerTool] = useState<"text" | "presentation" | "image">(initialSession.composerTool ?? "text");
  const [videoDispatchRequest, setVideoDispatchRequest] = useState<{ id: string; conversationId: string; prompt: string; request?: VideoChatRequest } | undefined>();
  const [webSearch, setWebSearch] = useState(false);
  const availability = useAiAvailability(api, user.id, composerTool === "image" ? "image" : "chat", setAiStatus);
  const availabilityScope = composerTool === "image" ? "image" : `${mode}:${webSearch ? "search" : "chat"}`;
  const availabilityCheck = availability.failures[availabilityScope] ?? availability.check;
  const availabilityBlocked = availability.checking || availabilityCheck?.state === "unavailable";
  const draftKey =
    activeConversationId ??
    (activeProjectId
      ? `new-project-conversation:${activeProjectId}`
      : "new-conversation");
  const draft = drafts[draftKey] ?? "";
  const attachments = draftAttachments[draftKey] ?? [];
  const persistedVideoResumeRequest = useMemo(() => {
    const settings = videoDraftSettings[draftKey];
    if (!settings || settings.aspectRatio === "1:1") return undefined;
    const references = videoReferencesFromAttachments(attachments);
    if (!references.ok) return undefined;
    const request: VideoChatRequest = {
      requestId: `draft-${draftKey}`,
      prompt: draft,
      originalPrompt: draft,
      model: settings.model,
      seconds: settings.seconds,
      resolution: settings.resolution,
      aspectRatio: settings.aspectRatio,
      ...(references.images.length ? { referenceImages: references.images } : {}),
    };
    return {
      // Stable for this pending conversation draft: autosave, attachment
      // hydration, or rerenders must not reopen a panel the member closed.
      id: `video-draft:${draftKey}`,
      conversationId: activeConversationId ?? draftKey,
      prompt: draft,
      request,
    };
  }, [activeConversationId, attachments, draft, draftKey, videoDraftSettings]);
  const activeVideoDispatchRequest = videoDispatchRequest?.conversationId === activeConversationId
    ? videoDispatchRequest
    : persistedVideoResumeRequest;
  // A followup chip only fills the composer draft: appended after any existing
  // text, never sent, never an authorization of a paid tool.
  useEffect(() => {
    const onSelect = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail !== "string" || !detail.trim()) return;
      setDrafts(current => {
        const existing = current[draftKey] ?? "";
        return { ...current, [draftKey]: existing ? `${existing}\n${detail}` : detail };
      });
    };
    window.addEventListener("tongpin-ai:followup-select", onSelect);
    return () => window.removeEventListener("tongpin-ai:followup-select", onSelect);
  }, [draftKey]);
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
  const computerBridgeAvailable = Boolean(getComputerUseBridge());
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [enabledSkillIds, setEnabledSkillIds] = useState<Set<string>>(
    initialSession.enabledSkillIds,
  );
  const [announcement, setAnnouncement] = useState("");
  const [capacityNotice, setCapacityNotice] = useState<string | null>(null);
  const [workspaceDialog, setWorkspaceDialog] =
    useState<WorkspaceDialogState>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const announcementTimerRef = useRef<number | null>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef({ conversations, projects, artifacts, drafts, draftAttachments, videoDraftSettings, activeConversationId, activeProjectId, view, workspaceDialog });
  workspaceRef.current = { conversations, projects, artifacts, drafts, draftAttachments, videoDraftSettings, activeConversationId, activeProjectId, view, workspaceDialog };

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      statusGenerationRef.current += 1;
      window.removeEventListener("focus", onFocus);
      for (const request of requestRef.current.values()) request.controller.abort();
      requestRef.current.clear();
      preflightGate.cancel();
      for (const typing of typingRef.current.values()) window.clearTimeout(typing.timer);
      typingRef.current.clear();
    };
  }, [refreshStatus, preflightGate]);

  useEffect(() => {
    // A page switch aborts only the browser stream. The server may keep
    // generating, so reattach with GET by the exact saved requestId; never
    // repeat a paid POST on mount or reload.
    for (const pending of interruptedRequests) {
      void performChat(pending.conversationId, pending.messageId, pending.requestId);
    }
  }, [interruptedRequests]);

  useEffect(() => {
    const bridge = getComputerUseBridge();
    if (!bridge) {
      setComputerProbe(null);
      return;
    }
    let cancelled = false;
    const refreshComputerProbe = () => {
      void bridge.probe()
        .then(result => { if (!cancelled) setComputerProbe(result); })
        .catch(() => { if (!cancelled) setComputerProbe(null); });
    };
    refreshComputerProbe();
    window.addEventListener("focus", refreshComputerProbe);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshComputerProbe);
      void bridge.stopSession();
    };
  }, [user.id]);

  const artifactById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );
  const sidebarTaskStatuses = useMemo(() => Object.fromEntries(conversations.map(conversation => [conversation.id, conversationTaskStatus(conversation, artifacts, seenResults[conversation.id])])), [conversations, artifacts, seenResults]);
  const pendingVideoIds = artifacts.filter(artifact => !artifact.data?.mediaTaskRequestId && typeof artifact.data?.videoJobId === "string" && !artifact.data.videoSubmitError && !["completed", "failed", "uncertain"].includes(String(artifact.data.videoStatus))).map(artifact => `${artifact.id}\t${artifact.data!.videoJobId}`).sort().join("\n");
  useEffect(() => {
    if (!pendingVideoIds) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      for (const entry of pendingVideoIds.split("\n")) {
        const [artifactId, jobId] = entry.split("\t");
        if (controller.signal.aborted) return;
        try {
          const job = await videoBlobCache.loadJob(mediaCacheScope(session), jobId, async signal => (await api<{ job: import("../../shared/aiVideo").AiVideoJob }>(`/api/ai/videos/${encodeURIComponent(jobId)}`, { signal, headers: { "X-Tongpin-Account": user.id } })).job, controller.signal, 4000);
          if (!controller.signal.aborted) setArtifacts(current => current.map(artifact => artifact.id !== artifactId || artifact.data?.videoStatus === job.status ? artifact : { ...artifact, data: { ...artifact.data, videoStatus: job.status } }));
        } catch { /* A GET failure is not a failed generation and must never cause resubmission. */ }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), document.hidden ? 30000 : 12000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, user.id, pendingVideoIds]);
  const pendingMediaRequests = artifacts.filter(artifact => typeof artifact.data?.mediaTaskRequestId === "string" && !artifact.data.mediaTaskSubmitError && (
    !["completed", "failed", "cancelled"].includes(String(artifact.data.mediaTaskStatus))
    || artifact.kind === "图片" && !Array.isArray(artifact.data.images)
    || artifact.kind === "视频" && !artifact.data.mediaTaskServiceRequestId
  )).map(artifact => `${artifact.conversationId}\t${artifact.data!.mediaTaskRequestId}\t${artifact.kind === "视频" ? "video" : "image"}`).sort().join("\n");
  useEffect(() => {
    if (!pendingMediaRequests) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      for (const entry of pendingMediaRequests.split("\n")) {
        const [conversationId, requestId, intent] = entry.split("\t");
        if (controller.signal.aborted) return;
        try {
          const response = await api<unknown>(`/api/ai/media-tasks/by-request/${encodeURIComponent(requestId)}`, { signal: controller.signal, headers: { "X-Tongpin-Account": user.id } });
          const task = parseMediaTaskResponse(response, { requestId, conversationId, accountId: user.id, intent: intent === "video" ? "video" : "image" });
          if (!controller.signal.aborted) recordMediaTask(conversationId, requestId, task);
        } catch { /* A read failure never recreates a paid request. */ }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), document.hidden ? 30_000 : 12_000);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [api, user.id, pendingMediaRequests]);
  const activeConversation =
    conversations.find((item) => item.id === activeConversationId) ?? null;
  const activeActivity = activeConversationId ? conversationActivity[activeConversationId] : undefined;
  const responding = Boolean(activeActivity);
  const responsePhase = activeActivity?.phase ?? "waiting";
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  useEffect(() => {
    if (
      computerRequest &&
      (view !== "chat" || activeConversationId !== computerRequest.conversationId || !computerBridgeAvailable)
    ) {
      const cancelledRequest = computerRequest;
      void getComputerUseBridge()?.stopSession();
      setComputerRequest(null);
      if (
        !cancelledRequest.hasResult &&
        conversations.some(conversation => conversation.id === cancelledRequest.conversationId)
      ) {
        appendComputerResult(
          cancelledRequest.conversationId,
          view !== "chat" || activeConversationId !== cancelledRequest.conversationId
            ? "已因切换界面或对话停止电脑操作；如果已执行部分步骤，请到目标应用中核对。"
            : "本机电脑控制能力已不可用，电脑操作已停止；如果已执行部分步骤，请到目标应用中核对。",
        );
      }
    }
  }, [activeConversationId, computerBridgeAvailable, computerRequest, conversations, view]);
  const sendContext = [draftKey, draft, draftAttachments[draftKey], videoDraftSettings[draftKey], mode, composerTool, webSearch,
    activeConversation, activeProject, enabledSkillIds, persona.revision, view, workspaceDialog];
  const sendContextRef = useRef(sendContext);
  sendContextRef.current = sendContext;
  const visibleBudgetNotice = budgetNotice && sameSendContext(budgetNotice.context, sendContext)
    ? preflightNotice(budgetNotice.result) : undefined;
  useEffect(() => {
    if (preflightGate.cancelIfChanged(sendContextRef.current)) setCheckingQuota(false);
  }, [preflightGate, draftKey, draft, draftAttachments, videoDraftSettings, mode, composerTool, webSearch,
    activeConversation, activeProject, enabledSkillIds, persona.revision, view, workspaceDialog]);
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

  const persistentConversations = useMemo(() => conversationsForPersistence(conversations), [conversations]);
  const persistentDrafts = useMemo(() => draftsWithoutComputerRequests(drafts), [drafts]);
  const persistentState = useMemo(() => serializeWorkspace({
      view,
      mode,
      conversations: persistentConversations,
      projects,
      artifacts,
      drafts: persistentDrafts,
      draftAttachments,
      videoDraftSettings,
      composerTool,
      webSearch,
      activeConversationId,
      activeProjectId,
      enabledSkillIds,
      sidebarCollapsed,
    }), [view, mode, persistentConversations, projects, artifacts, persistentDrafts, draftAttachments, videoDraftSettings,
      composerTool, webSearch, activeConversationId, activeProjectId, enabledSkillIds, sidebarCollapsed]);
  const writeWorkspace = useCallback((body: AiWorkspaceSaveRequest) => {
    const payload = JSON.stringify(body);
    return api<AiWorkspaceSnapshot>("/api/ai/workspace", {
      method: "PUT", headers: { "X-Tongpin-Account": user.id }, body: payload,
    }, workspaceSaveTimeoutMs(payload.length));
  }, [api, user.id]);
  const persistence = useWorkspacePersistence(initialSnapshot, persistentState, writeWorkspace, user.id);
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const persistentStateRef = useRef(persistentState);
  persistentStateRef.current = persistentState;
  useEffect(() => {
    const unregister = registerAiLeaveGuard(user.id, async () => {
      if (preflightGate.cancel()) setCheckingQuota(false);
      const results = await Promise.all([...deletionTasksRef.current.values()]);
      return results.every(result => result === true) && persistenceRef.current.flushSaved();
    });
    const guard = (event: BeforeUnloadEvent) => {
      if (deletingConversationRef.current.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => { unregister(); window.removeEventListener("beforeunload", guard); };
  }, [user.id, preflightGate]);

  async function addFiles(files: File[], signal?: AbortSignal) {
    if (fileImportRef.current.has(draftKey)) { showAnnouncement("正在读取此对话的附件，请稍候"); return; }
    if (files.length + attachments.length > 5) { showAnnouncement("每次最多添加 5 个附件"); return; }
    if (preflightGate.cancel()) setCheckingQuota(false);
    fileImportRef.current.add(draftKey);
    const target = draftKey;
    try {
      if (composerTool === "image") {
        if (!aiStatus?.imageEditTiers?.includes(mode)) throw new Error("当前档位尚未配置参考图编辑，附件尚未添加");
        if (files.some(file => !/\.(?:png|jpe?g|webp)$/i.test(file.name))) throw new Error("图片生成只接受 PNG、JPEG 或 WebP 参考图");
      }
      // Decode one source at a time; parallel video/image surfaces can stall low-memory devices.
      const extracted: Awaited<ReturnType<typeof extractAttachment>>[] = [];
      for (const file of files) {
        signal?.throwIfAborted();
        extracted.push(await extractAttachment(file, { signal }));
      }
      signal?.throwIfAborted();
      if (composerTool === "image" && extracted.some(item => item.media?.kind !== "image")) throw new Error("图片生成只接受图片参考附件");
      if (composerTool !== "image" && extracted.some(item => item.media) && !aiStatus?.visionEnabled) throw new Error("管理员尚未启用图片理解，请先启用支持视觉输入的模型；附件尚未添加");
      const documents = extracted.map(item => ({ id: createLocalId("document"), name: item.name, mimeType: item.mediaType, content: item.text, ...(item.media ? { media: item.media } : {}) }));
      if (!mountedRef.current) return;
      const latest = workspaceRef.current;
      const targetExists = target === "new-conversation" || latest.conversations.some(item => item.id === target) || latest.projects.some(item => `new-project-conversation:${item.id}` === target);
      if (!targetExists) return;
      const existing = latest.draftAttachments[target] ?? [];
      const merged = [...existing, ...documents.filter(doc => !existing.some(item => item.name === doc.name && item.mimeType === doc.mimeType && item.content === doc.content && JSON.stringify(item.media) === JSON.stringify(doc.media)))];
      validateAttachments(merged.map(workspaceAttachment));
      documentAttachments(merged);
      ensureAttachmentWorkspaceCapacity({ ...persistentStateRef.current, draftAttachments: { ...latest.draftAttachments, [target]: merged } });
      setCapacityNotice(null);
      setDraftAttachments(current => ({ ...current, [target]: merged }));
      const warnings = extracted.flatMap(item => item.warnings);
      if (warnings.length) showAnnouncement(warnings.join("；"));
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof WorkspaceCapacityError) { setCapacityNotice(error.message); return; }
      throw error;
    }
    finally { fileImportRef.current.delete(target); }
  }

  const spaceRejected = capacityNotice !== null
    || (persistence.status === "error" && isWorkspaceSpaceRejection(persistence.errorCode));
  // Computed only while a space notice is visible; never during ordinary chat rendering.
  const largestConversations = useMemo(
    () => spaceRejected ? largestWorkspaceConversations(persistentState, 5) : [],
    [spaceRejected, persistentState],
  );

  async function exportConversationThenDelete(conversationId: string) {
    const json = conversationExportJson(persistentStateRef.current, conversationId);
    const conversation = persistentStateRef.current.conversations.find(item => item.id === conversationId);
    if (!json || !conversation) return;
    const result = await saveBlobWithFeedback(
      new Blob([json], { type: "application/json;charset=utf-8" }),
      conversationExportFilename(conversation.title),
    );
    // Deletion still goes through the existing confirmation dialog; never automatic.
    if (mountedRef.current && (result.state === "saved" || result.state === "started")) openDeleteConversationDialog(conversationId);
  }

  function exportWorkspace() {
    void saveBlobWithFeedback(
      new Blob([JSON.stringify(persistentState, null, 2)], { type: "application/json;charset=utf-8" }),
      "同频-AI-对话备份.json",
    );
  }

  function updateDraft(value: string) {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }

  function requestConversationId() {
    if (activeConversation?.id) return activeConversation.id;
    const existing = draftConversationIdsRef.current.get(draftKey);
    if (existing) return existing;
    const created = createLocalId("conversation");
    draftConversationIdsRef.current.set(draftKey, created);
    return created;
  }

  function conversationBusy(conversationId: string | null | undefined) {
    return hasConversationActivity(
      conversationId,
      conversationActivity,
      requestRef.current,
      pendingGenerationRef.current,
      typingRef.current,
    );
  }

  function appendComputerResult(conversationId: string, content: string) {
    setConversations(current => current.map(conversation => conversation.id === conversationId
      ? {
          ...conversation,
          timeLabel: "刚刚",
          messages: [...conversation.messages, {
            id: createLocalId("assistant"),
            role: "assistant" as const,
            content,
            status: "ready" as const,
            time: currentTimeLabel(),
          }],
        }
      : conversation));
  }

  function beginComputerUse(originalPrompt: string, existingConversationId?: string, contextHint?: string) {
    if (!computerBridgeAvailable || !getComputerUseBridge()) {
      showAnnouncement("电脑控制只在同频桌面端中提供");
      return;
    }
    if (!serviceConnected || quotaInsufficient || connectionError || availabilityBlocked) {
      showAnnouncement("同频 AI 规划暂不可用，请先恢复连接或额度");
      return;
    }
    if (conversationBusy(activeConversationId)) {
      showAnnouncement("请先停止当前 AI 回复，再开启电脑控制");
      return;
    }
    if (attachments.length) {
      showAnnouncement("电脑控制不会读取聊天附件，请先移除附件");
      return;
    }
    // Say it before any permission check, session or window snapshot.
    const tierBlock = computerTierNotice(aiStatus?.computerTiers, mode);
    if (tierBlock) {
      showAnnouncement(tierBlock, 9_000);
      return;
    }

    const conversationId = existingConversationId ?? activeConversation?.id ?? createLocalId("conversation");
    const userMessage = {
      id: createLocalId("user"),
      role: "user" as const,
      content: computerUseConversationRequestMessage(originalPrompt),
      time: currentTimeLabel(),
    };
    if (existingConversationId) {
      // The dispatch turn already persisted the user's request. Continue from
      // that same turn instead of inserting a duplicate user message.
    } else if (activeConversation) {
      setConversations(current => current.map(conversation => conversation.id === conversationId
        ? { ...conversation, timeLabel: "刚刚", messages: [...conversation.messages, userMessage] }
        : conversation));
    } else {
      setConversations(current => [{
        id: conversationId,
        projectId: activeProject?.id,
        title: "安全电脑控制",
        timeLabel: "刚刚",
        messages: [userMessage],
      }, ...current]);
    }

    setDrafts(current => {
      const next = { ...current };
      delete next[draftKey];
      next[conversationId] = "";
      return next;
    });
    setDraftAttachments(current => {
      const next = { ...current };
      delete next[draftKey];
      delete next[conversationId];
      return next;
    });
    setVideoDraftSettings(current => {
      const next = { ...current };
      delete next[draftKey];
      delete next[conversationId];
      return next;
    });
    setActiveConversationId(conversationId);
    setActiveProjectId(activeProject?.id ?? null);
    setView("chat");
    setArtifactOpen(false);
    setComposerTool("text");
    setWebSearch(false);
    setComputerRequest({
      id: createLocalId("computer"),
      conversationId,
      originalPrompt,
      ...(contextHint && contextHint !== originalPrompt ? { contextHint } : {}),
      mode,
      hasResult: false,
    });
  }

  function recordComputerResult(content: string) {
    const request = computerRequest;
    if (!request || !conversations.some(conversation => conversation.id === request.conversationId)) return;
    appendComputerResult(request.conversationId, content);
    setComputerRequest(current => current?.id === request.id ? { ...current, hasResult: true } : current);
  }

  function closeComputerUse() {
    const request = computerRequest;
    setComputerRequest(null);
    if (request && !request.hasResult && conversations.some(conversation => conversation.id === request.conversationId)) {
      appendComputerResult(request.conversationId, "安全电脑控制会话已关闭，未执行任何操作。");
    }
  }

  function showAnnouncement(message: string, durationMs = 3_200) {
    setAnnouncement(message);
    if (announcementTimerRef.current !== null)
      window.clearTimeout(announcementTimerRef.current);
    announcementTimerRef.current = window.setTimeout(() => {
      setAnnouncement("");
      announcementTimerRef.current = null;
    }, durationMs);
  }

  useEffect(() => {
    const onDownloadFeedback = (event: Event) => {
      const detail = (event as CustomEvent<AiDownloadFeedback>).detail;
      // A saved path or a failure is something the member needs time to read.
      if (detail?.message) showAnnouncement(detail.message, detail.state === "saved" || detail.state === "error" ? 9_000 : 4_000);
    };
    window.addEventListener(AI_DOWNLOAD_FEEDBACK_EVENT, onDownloadFeedback);
    return () => window.removeEventListener(AI_DOWNLOAD_FEEDBACK_EVENT, onDownloadFeedback);
  }, []);

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
    if (conversationBusy(conversationId)) {
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
    draftConversationIdsRef.current.delete(pendingDraftKey);
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
    setVideoDraftSettings(current => {
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
    setVideoDraftSettings(current => { const next = { ...current }; delete next[`new-project-conversation:${projectId}`]; return next; });
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
    if (conversationBusy(conversationId)) {
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
        setVideoDraftSettings(next.videoDraftSettings ?? {});
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

  function updateHarnessTrace(conversationId: string, messageId: string, trace: AiHarnessTrace) {
    setConversations(current => {
      const existing = current.find(item => item.id === conversationId)?.messages.find(message => message.id === messageId)?.trace;
      if (sameHarnessTrace(existing, trace)) return current;
      return replaceChatMessage(current, conversationId, messageId, { trace });
    });
  }

  function setReplyActivity(conversationId: string, messageId: string, phase: "waiting" | "typing") {
    setConversationActivity(current => ({ ...current, [conversationId]: { messageId, phase } }));
  }

  function clearReplyActivity(conversationId: string, messageId?: string) {
    setConversationActivity(current => {
      if (!current[conversationId] || messageId && current[conversationId].messageId !== messageId) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }

  function displayReply(conversationId: string, messageId: string, response: AiChatResponse, preserveExistingTrace = false) {
    retryRequestsRef.current.delete(messageId);
    const finish = () => {
      const typing = typingRef.current.get(conversationId);
      if (typing?.messageId === messageId) {
        window.clearTimeout(typing.timer);
        typingRef.current.delete(conversationId);
      }
      if (!mountedRef.current) return;
      updateReply(conversationId, messageId, completedReply(response, { preserveExistingTrace }));
      clearReplyActivity(conversationId, messageId);
    };
    finish();
  }

  function acceptGeneration(conversationId: string, messageId: string, response: AiChatResponse | AiImageResponse, harnessPlanRequestId?: string) {
    const latestConversation = liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId);
    if (!latestConversation) { clearReplyActivity(conversationId, messageId); return; }
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
        data: imageResult
          ? { images: response.images.map(item => ({ ...item })), ...(harnessPlanRequestId ? { harnessPlanRequestId } : {}) }
          : { presentation: { ...presentation!, slides: presentation!.slides.map(slide => ({ ...slide })) }, ...(harnessPlanRequestId ? { harnessPlanRequestId } : {}) },
      };
      setArtifacts(current => [artifact, ...current.filter(item => item.id !== artifactId)]);
      updateReply(conversationId, messageId, { artifactId });
    }
    setAiStatus(current => current ? { ...current, quota: response.quota } : current);
    displayReply(conversationId, messageId, imageResult ? { ...response, content: "图片已生成，点击下方成果查看和下载。" } : response, Boolean(harnessPlanRequestId));
  }

  async function performChat(conversationId: string, messageId: string, request: GenerationRequest | string) {
    if (requestRef.current.has(conversationId) || typingRef.current.has(conversationId)) return;
    // Reading an already submitted request remains possible even during an outage.
    if (typeof request !== "string" && availabilityBlocked) { clearReplyActivity(conversationId, messageId); return; }
    if (!mountedRef.current || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) {
      if (mountedRef.current) clearReplyActivity(conversationId, messageId);
      return;
    }
    const controller = new AbortController();
    let liveContent = "", liveSummary = "", liveProcess = EMPTY_REPLY_PROCESS_LIVE, deltaTimer: ReturnType<typeof setTimeout> | undefined;
    const flushDeltas = () => { deltaTimer = undefined; if (mountedRef.current && !controller.signal.aborted) setStreamReplies(current => ({ ...current, [messageId]: { content: liveContent, analysisSummary: liveSummary, liveProcess } })); };
    requestRef.current.set(conversationId, { controller, messageId });
    // Only requests that were never sent may be POSTed by the retry button.
    retryRequestsRef.current.delete(messageId);
    const requestId = typeof request === "string" ? request : request.requestId;
    const persistedReply = workspaceRef.current.conversations
      .find(item => item.id === conversationId)?.messages
      .find(message => message.id === messageId);
    const persistedStartedAt = persistedReply?.startedAt;
    const now = Date.now();
    const originalDeadline = Number.isSafeInteger(persistedStartedAt) && persistedStartedAt! <= now
      ? persistedStartedAt! + 180_000 : now + 180_000;
    const deadline = typeof request === "string"
      ? Math.min(now + 180_000, Math.max(now + 30_000, originalDeadline))
      : now + 180_000;
    const recover = () => waitForReply((signal, timeoutMs) => api<AiRequestResult>(
      `/api/ai/requests/${encodeURIComponent(requestId)}`,
      { headers: { "X-Tongpin-Account": user.id }, signal }, timeoutMs,
    ), controller.signal, deadline);
    if (typeof request === "string") { liveContent = persistedReply?.content ?? ""; liveSummary = persistedReply?.analysisSummary ?? ""; }
    // Wall time from the member's send, measured only for a request sent live
    // from this page; a read-only reattach cannot know when the run really ended.
    const replyStartedAt = Number.isSafeInteger(persistedStartedAt) && persistedStartedAt! <= now ? persistedStartedAt! : now;
    const settledProcess = (outcome: "completed" | "partial" | "stopped" | "failed", live = liveProcess) =>
      typeof request === "string" ? undefined : settleReplyProcess(live, { outcome, durationMs: Date.now() - replyStartedAt });
    setReplyActivity(conversationId, messageId, "waiting");
    updateReply(conversationId, messageId, {
      content: liveContent,
      status: "thinking",
      taskPhase: "running",
      startedAt: Number.isSafeInteger(persistedStartedAt) ? persistedStartedAt : Date.now(),
    });
    try {
      let response: AiChatResponse | AiImageResponse;
      if (typeof request === "string") response = await recover();
      else {
        try {
          response = "prompt" in request ? await api<AiImageResponse>("/api/ai/images", {
            method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(request), signal: controller.signal,
          }, 130_000) : await readAiChatStream(api, request, { accountId: user.id, signal: controller.signal, onEvent: event => {
            // Ordered process parts come from real events only; raw provider
            // reasoning (reasoning_delta) is never shown or stored.
            const nextProcess = applyReplyProcessEvent(liveProcess, event);
            const processChanged = nextProcess !== liveProcess;
            liveProcess = nextProcess;
            if (event.type === "answer_delta") liveContent += event.data.delta;
            else if (event.type === "public_summary_delta") liveSummary += event.data.delta;
            else if (!processChanged || event.type === "run_finished") return;
            if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, 60);
          } });
        } catch (error) {
          if (controller.signal.aborted || !(shouldRecoverReply(error) || error instanceof ApiRequestError && error.code === "AI_STREAM_INTERRUPTED")) throw error;
          response = await recover();
        }
      }
      if (!mountedRef.current || controller.signal.aborted) return;
      // Keep the bounded process record only when the live journal reached its
      // end; a reply recovered by GET falls back to its saved summary fields.
      if (typeof request === "string") { if (persistedReply?.process) updateReply(conversationId, messageId, { process: undefined }); }
      else if (liveProcess.finishedAt !== undefined) {
        const process = settledProcess(!("images" in response) && response.completion ? "partial" : "completed");
        if (process) updateReply(conversationId, messageId, { process });
      }
      const persistedMessage = workspaceRef.current.conversations.find(item => item.id === conversationId)?.messages.find(message => message.id === messageId);
      const harnessPlanRequestId = typeof request === "string"
        ? persistedMessage?.harnessPlanRequestId
        : "prompt" in request ? request.planRequestId : request.toolPlanRequestId;
      if (!("images" in response) && response.dispatch) {
        const decision = response.dispatch;
        if (decision.kind === "text" || decision.clarification) {
          acceptGeneration(conversationId, messageId, { ...response, content: decision.kind === "text" ? decision.content : decision.clarification! });
          if (decision.kind !== "text") updateReply(conversationId, messageId, { taskPhase: "awaiting_input" });
          return;
        }
        if (typeof request === "string") {
          // The dispatch result is durable but its attachment/settings snapshot
          // is not. A read-only remount must not silently start a new tool POST.
          const kind = { image: "图片", video: "视频", presentation: "演示文稿", computer: "电脑操作" }[decision.kind];
          acceptGeneration(conversationId, messageId, { ...response, content: `已恢复原任务：同频 AI 建议生成${kind}。请重新确认任务输入后再继续；本次未自动调用工具。` });
          updateReply(conversationId, messageId, { taskPhase: "awaiting_input" });
          return;
        }
        // Dispatch only classifies the already-persisted turn. Release its
        // local lock before entering the real, independently validated plan.
        requestRef.current.delete(conversationId);
        pendingGenerationRef.current.delete(conversationId);
        const originalPrompt = typeof request !== "string" && !("prompt" in request)
          ? request.messages.filter(message => message.role === "user").at(-1)?.content ?? decision.prompt
          : decision.prompt;
        const snapshot = submissionSnapshotsRef.current.get(messageId);
        if (!snapshot) throw new Error("任务输入快照暂不可恢复，请重新生成；不会使用其他对话的设置或附件。");
        const continuation: TaskContinuation = { conversationId, messageId, originalPrompt, snapshot };
        if (decision.kind === "image" || decision.kind === "video") {
          // The classifier did not receive permission to spend media points.
          // Reuse this already-saved turn and let the durable task ask the
          // member to authorize its server-estimated cost in the chat.
          const accepted = await submitMediaTask(decision.kind, originalPrompt, undefined, "natural", undefined, continuation);
          if (!accepted) {
            const reply = workspaceRef.current.conversations.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
            if (reply?.status !== "error") updateReply(conversationId, messageId, { status: "error", taskPhase: "failed", content: "媒体任务未启动，请检查参考素材或同步状态；草稿已保留。" });
            setDrafts(current => current[conversationId]?.trim() ? current : { ...current, [conversationId]: originalPrompt });
          }
          return;
        }
        if (decision.kind === "presentation") {
          const plan = await planTool(decision.kind, decision.prompt, undefined, continuation);
          if (plan) await sendMessage({ ...plan, originalPrompt }, continuation);
          return;
        }
        clearReplyActivity(conversationId, messageId);
        const computerReady = Boolean(computerBridgeAvailable && getComputerUseBridge());
        const computerProcess = settledProcess("completed", withReplyProcessTool(liveProcess, { kind: "tool", tool: "computer", status: computerReady ? "handed_off" : "unavailable" }));
        updateReply(conversationId, messageId, { content: computerReady ? "已识别为电脑操作任务，即将进入系统安全确认流程。" : "已识别为电脑操作任务，但当前环境未接入安全桌面能力。", status: "ready", startedAt: undefined, ...(computerProcess ? { process: computerProcess } : {}) });
        if (computerReady) beginComputerUse(originalPrompt, conversationId, decision.prompt);
        return;
      }
      acceptGeneration(conversationId, messageId, response, harnessPlanRequestId);
    } catch (error) {
      if (!mountedRef.current) return;
      const interrupted = controller.signal.aborted;
      if (!interrupted && typeof request !== "string") availability.recordFailure("prompt" in request ? "image" : `${request.mode}:${request.webSearch ? "search" : "chat"}`, error);
      const originalMissing = typeof request === "string" && error instanceof ApiRequestError && error.status === 404;
      const recoverable = !originalMissing && canRecoverChatRequest(error instanceof ApiRequestError ? error.code : undefined, interrupted);
      const stoppedProcess = settledProcess(interrupted ? "stopped" : "failed");
      const failureText = interrupted
        ? "已停止等待。请求可能仍在处理，实际扣额请查看 Token 使用详情。"
        : error instanceof ApiRequestError && error.code === "NETWORK_UNAVAILABLE"
          ? "连接中断，暂时没有收到完整回复。可重新获取同一请求，避免重复发送。"
          : error instanceof Error ? error.message : "暂时无法获取回复，请稍后重试。";
      // A reply cut off mid-stream keeps what arrived, and says why it stops there.
      const content = originalMissing
        ? "原请求没有服务端记录或已过期，本次未自动重新发送。请重新输入任务后再发送。"
        : liveContent ? (interrupted ? liveContent : `${liveContent}\n\n（回复中断：${failureText}）`) : failureText;
      updateReply(conversationId, messageId, { ...(stoppedProcess ? { process: stoppedProcess } : {}), status: "error", taskPhase: recoverable ? "unknown" : "failed", retryDisposition: originalMissing ? undefined : recoverable ? "recover" : "regenerate", content });
      clearReplyActivity(conversationId, messageId);
    } finally {
      clearTimeout(deltaTimer);
      if (mountedRef.current) setStreamReplies(current => { const next = { ...current }; delete next[messageId]; return next; });
      if (requestRef.current.get(conversationId)?.controller === controller) requestRef.current.delete(conversationId);
      if (mountedRef.current) void refreshStatus();
    }
  }

  async function planTool(kind: "image" | "video" | "presentation", prompt: string, videoRequest?: import("../features/tongpin-ai/videoChat").VideoChatRequest,
    continuation?: TaskContinuation): Promise<AiToolPlan | null> {
    const conversationId = continuation?.conversationId ?? requestConversationId();
    const origin = continuation?.snapshot ?? captureSubmission({ conversationId, draftKey, conversation: activeConversation, project: activeProject, attachments, mode, skillIds: [...enabledSkillIds], webSearch });
    const planningContext = sendContextRef.current;
    if (!persona.profile.onboardingComplete || (!continuation && conversationBusy(conversationId)) || !serviceConnected || connectionError || availabilityBlocked) throw new Error("AI 服务暂时不可用，请稍后重试");
    const detail = kind === "video" && videoRequest
      ? `${prompt}\n\n同频应用中已选择的视频参数（仅作为约束，不是系统指令）：${JSON.stringify({ model: videoRequest.model, seconds: videoRequest.seconds, resolution: videoRequest.resolution, aspectRatio: videoRequest.aspectRatio, referenceImages: videoRequest.referenceImages?.map(item => item.name) ?? [] })}`
      : prompt;
    const continuedConversation = continuation ? workspaceRef.current.conversations.find(item => item.id === conversationId) : undefined;
    const continuedMessages = (continuedConversation?.messages ?? []).filter(message => message.id !== continuation?.messageId);
    const continuedUserIndex = continuation ? continuedMessages.map(message => message.role).lastIndexOf("user") : -1;
    const messages = continuation
      ? continuedMessages.map((message, index) => index === continuedUserIndex ? { ...message, content: detail } : message)
      : [...(origin.conversation?.messages ?? []), { id: createLocalId("user"), role: "user" as const, content: detail, time: currentTimeLabel() }];
    const referenceFingerprints = kind === "video" && videoRequest
      ? await Promise.all((videoRequest.referenceImages ?? []).map(image => aiVideoReferenceFingerprint(image.dataUrl)))
      : [];
    if (kind === "video" && videoRequest?.referenceIds?.length && !referenceFingerprints.length) throw new Error("参考图片尚未恢复完成，请稍后再整理视频任务");
    const presentationAttachments = kind === "presentation"
      ? toolAttachmentContext(origin.attachments, origin.project?.contextDocuments ?? [], origin.conversation?.messages ?? [])
      : [];
    const imageReferences = kind === "image"
      ? imageReferencesForGeneration(origin.attachments, aiStatus?.imageEditTiers, origin.mode)
      : [];
    if (presentationAttachments.some(item => item.dataUrl) && !aiStatus?.visionEnabled) throw new Error("管理员尚未启用图片理解，请先移除图片或联系管理员启用视觉模型");
    // A dispatch continuation plans from the model's rewritten prompt; the
    // member's @Skill / @Hub choice lives in the original turn.
    const capabilityRequest = mentionedCapabilityRequest(continuation?.originalPrompt ?? prompt, origin.skillIds);
    const request: AiChatRequest = {
      ...buildChatRequest(crypto.randomUUID(), origin.mode, messages),
      conversationId,
      ...capabilityRequest,
      projectContext: origin.project?.instructions || undefined,
      outputFormat: kind === "video" ? "video_plan" : kind === "presentation" ? "presentation_plan" : "image_plan",
      ...(kind === "video" && videoRequest ? { videoParameters: {
        model: videoRequest.model,
        seconds: videoRequest.seconds,
        resolution: videoRequest.resolution,
        aspectRatio: videoRequest.aspectRatio,
        referenceCount: videoRequest.referenceImages?.length ?? videoRequest.referenceIds?.length ?? 0,
        referenceFingerprints,
      } } : {}),
      ...(kind === "video" && aiStatus?.visionEnabled && videoRequest?.referenceImages?.length ? { attachments: videoRequest.referenceImages.slice(0, 2).map(item => ({ name: item.name, mediaType: item.dataUrl.slice(5, item.dataUrl.indexOf(";")), dataUrl: item.dataUrl })) } : {}),
      ...(imageReferences.length ? { attachments: imageReferences } : {}),
      ...(presentationAttachments.length ? { attachments: presentationAttachments } : {}),
    };
    const headers = { "X-Tongpin-Account": user.id };
    const preflight = await api<AiChatPreflight>("/api/ai/preflight", { method: "POST", headers, body: JSON.stringify(request) });
    statusGenerationRef.current += 1;
    if (mountedRef.current) setAiStatus(current => current ? { ...current, quota: preflight.quota } : current);
    if (!preflight.canSend) throw new Error(preflightNotice(preflight).message);
    const response = await api<AiChatResponse>("/api/ai/chat", { method: "POST", headers, body: JSON.stringify(request) }, 130_000);
    if (mountedRef.current) setAiStatus(current => current ? { ...current, quota: response.quota } : current);
    const clarification = response.toolClarification?.trim();
    if (clarification) {
      if (!mountedRef.current || continuation && !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, continuation.messageId)) return null;
      if (!continuation && (!sameSendContext(planningContext, sendContextRef.current) || requestConversationId() !== conversationId)) return null;
      const latest = workspaceRef.current;
      const current = latest.conversations.find(item => item.id === conversationId);
      const preserveVideoDraft = (state: import("../../shared/aiWorkspace").AiWorkspaceState) =>
        kind === "video" && videoRequest
          ? preserveVideoClarificationDraft(state, conversationId, prompt, videoRequest)
          : state;
      if (continuation) {
        if (!current?.messages.some(message => message.id === continuation.messageId)) return null;
        const next = preserveVideoDraft({ ...persistentStateRef.current,
          conversations: latest.conversations.map(item => item.id !== conversationId ? item : { ...item, messages: item.messages.map(message => message.id !== continuation.messageId ? message : {
            ...message, requestId: response.requestId, content: clarification, status: "ready" as const, taskPhase: "awaiting_input" as const, startedAt: undefined,
            ...(response.trace ? { trace: response.trace } : {}),
          }) }),
        });
        workspaceRef.current = { ...latest, conversations: next.conversations, drafts: next.drafts,
          draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {} };
        persistentStateRef.current = next;
        setConversations(next.conversations);
        setDrafts(next.drafts); setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
        if (kind === "video" && videoRequest) setVideoDispatchRequest({ id: crypto.randomUUID(), conversationId, prompt, request: videoRequest });
        clearReplyActivity(conversationId, continuation.messageId);
        const saved = await persistenceRef.current.saveNow(next);
        if (!saved && mountedRef.current) showAnnouncement("AI 需要你补充信息，但记录尚未保存。请先恢复同步后重试。");
        return null;
      }
      const conversation: TongpinAIConversation = {
        ...(current ?? { id: conversationId, projectId: activeProject?.id, title: Array.from(prompt.split("\n")[0]).slice(0, 28).join("") }),
        timeLabel: "刚刚",
        messages: [...(current?.messages ?? []),
          { id: createLocalId("user"), role: "user", content: prompt, time: currentTimeLabel(), ...(attachments.length ? { attachments } : {}) },
          { id: createLocalId("assistant"), requestId: response.requestId, role: "assistant", content: clarification, status: "ready", time: currentTimeLabel(), ...(response.trace ? { trace: response.trace } : {}) }],
      };
      const next = preserveVideoDraft(withPreparedChatSend({ ...persistentStateRef.current,
        conversations: latest.conversations, projects: latest.projects, artifacts: latest.artifacts,
        drafts: latest.drafts, draftAttachments: latest.draftAttachments, videoDraftSettings: latest.videoDraftSettings, activeProjectId: latest.activeProjectId,
      }, conversation, draftKey));
      try { ensureAttachmentWorkspaceCapacity(next, "reply"); setCapacityNotice(null); }
      catch (error) {
        if (error instanceof WorkspaceCapacityError) setCapacityNotice(error.message);
        else showAnnouncement(error instanceof Error ? error.message : "保存空间不足，原输入已保留");
        return null;
      }
      const saved = await persistenceRef.current.saveNow(next);
      if (!saved) { showAnnouncement("AI 需要你补充信息，但记录尚未保存，原输入已保留。请先恢复同步后重试。"); return null; }
      if (!mountedRef.current) return null;
      workspaceRef.current = { ...latest, conversations: next.conversations, drafts: next.drafts,
        draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {}, activeConversationId: conversationId, view: "chat" };
      persistentStateRef.current = next;
      setConversations(next.conversations); setActiveConversationId(conversationId); setView("chat");
      setDrafts(next.drafts); setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
      if (kind === "video" && videoRequest) setVideoDispatchRequest({ id: crypto.randomUUID(), conversationId, prompt, request: videoRequest });
      draftConversationIdsRef.current.delete(draftKey);
      return null;
    }
    if (!response.toolPlan || response.toolPlan.kind !== kind) throw new Error("同频 AI 没有返回可确认的生成方案，请重新整理任务");
    return { ...response.toolPlan, planRequestId: response.requestId, ...(response.trace ? { trace: response.trace } : {}) };
  }

  function recordMediaTask(conversationId: string, requestId: string, task: MediaTaskRun) {
    if (task.requestId !== requestId || task.conversationId !== conversationId) return;
    const latest = workspaceRef.current;
    const nextArtifacts = latest.artifacts.map(artifact => {
      if (artifact.conversationId !== conversationId || artifact.data?.mediaTaskRequestId !== requestId) return artifact;
      const serviceRequestId = task.tool?.serviceRequestId;
      const resultIds = task.tool?.artifactIds ?? [];
      const data = { ...artifact.data, mediaTaskRunId: task.runId, mediaTaskStatus: task.status,
        ...(serviceRequestId ? { mediaTaskServiceRequestId: serviceRequestId, ...(artifact.kind === "视频" ? { videoJobId: serviceRequestId } : {}) } : {}),
        ...(resultIds.length ? { mediaTaskResultIds: resultIds,
          ...(artifact.kind === "图片" && !Array.isArray(artifact.data?.images) ? { images: resultIds.map(assetId => ({ assetId })) } : {}) } : {}) };
      return JSON.stringify(data) === JSON.stringify(artifact.data) ? artifact : { ...artifact, data };
    });
    if (nextArtifacts.every((artifact, index) => artifact === latest.artifacts[index])) return;
    workspaceRef.current = { ...latest, artifacts: nextArtifacts };
    persistentStateRef.current = { ...persistentStateRef.current, artifacts: nextArtifacts };
    setArtifacts(nextArtifacts);
    if (["completed", "failed", "cancelled", "unknown"].includes(task.status)) void refreshStatus();
  }

  async function submitMediaTask(kind: "image" | "video", prompt: string, videoRequest: VideoChatRequest | undefined,
    entrypoint: "natural" | "mention_image" | "mention_video" | "menu", suppliedVideoPoints?: number,
    continuation?: TaskContinuation,
    selectedImage?: { artifactId: string; requestId: string; sourceArtifactId: string; assetId: string; previousSettings?: AiWorkspaceVideoDraftSettings }): Promise<boolean> {
    const conversationId = continuation?.conversationId ?? requestConversationId();
    if (!prompt.trim() || !persona.profile.onboardingComplete || !continuation && conversationBusy(conversationId) || !serviceConnected || quotaInsufficient || !continuation && fileImportRef.current.has(draftKey)) return false;
    if (persistenceRef.current.status === "error" || persistenceRef.current.status === "conflict") { showAnnouncement("请先完成记录同步，再提交媒体任务"); return false; }
    const origin = continuation?.snapshot ?? captureSubmission({ conversationId, draftKey, conversation: activeConversation, project: activeProject, attachments, mode, skillIds: [...enabledSkillIds], webSearch: false });
    if (origin.conversation && !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId)) return false;
    let priorImageIds: string[] = [];
    if (kind === "image") {
      if (!aiStatus?.imageEnabled) { showAnnouncement("请管理员先配置图片生成功能"); return false; }
      try {
        imageReferencesForGeneration(origin.attachments, aiStatus.imageEditTiers, origin.mode);
        if (!origin.attachments.length) priorImageIds = generatedImageEditReferenceIds(origin.conversation, workspaceRef.current.artifacts, prompt);
        if (priorImageIds.length && !aiStatus.imageEditTiers?.includes(origin.mode)) throw new Error("当前档位尚未配置参考图编辑，请切换档位或移除图片指代");
      }
      catch (error) { showAnnouncement(error instanceof Error ? error.message : "参考图片无效，未提交生成"); return false; }
    } else {
      const migration = videoReferencesFromAttachments(origin.attachments);
      if (!migration.ok) { showAnnouncement(migration.message); return false; }
    }
    const candidates = kind === "video" && !selectedImage && !origin.attachments.length && !videoRequest?.referenceImages?.length && !videoRequest?.referenceIds?.length
      ? generatedVideoReferenceCandidates(origin.conversation, workspaceRef.current.artifacts, prompt) : undefined;
    if (candidates && candidates.assetIds.length > 20) { showAnnouncement("上一条成果图片过多，请先手动上传要用的参考图片；本次未提交生成。"); return false; }
    if (candidates && candidates.assetIds.length > 1) {
      const requestId = videoRequest?.requestId ?? crypto.randomUUID();
      const messageId = continuation?.messageId ?? createLocalId("assistant");
      const artifactId = `artifact-${requestId}`;
      const current = workspaceRef.current;
      const ownedConversation = current.conversations.find(item => item.id === conversationId) ?? origin.conversation;
      const selection: GeneratedImageSelection = {
        requestId, sourceArtifactId: candidates.sourceArtifactId, assetIds: candidates.assetIds, mode: origin.mode, entrypoint,
        status: "awaiting_selection",
        ...(videoRequest ? { videoOptions: { ...(videoRequest.model ? { model: videoRequest.model } : {}), seconds: videoRequest.seconds, resolution: videoRequest.resolution, aspectRatio: videoRequest.aspectRatio } } : {}),
        ...(current.videoDraftSettings[origin.draftKey] ? { previousSettings: current.videoDraftSettings[origin.draftKey] } : {}),
      };
      const conversation: TongpinAIConversation = {
        ...(ownedConversation ?? { id: conversationId, projectId: origin.project?.id, title: Array.from(prompt).slice(0, 28).join("") }),
        timeLabel: "刚刚",
        messages: continuation ? (ownedConversation?.messages ?? []).map(message => message.id === messageId
          ? { ...message, content: "请选择要用于视频的图片。", status: "ready" as const, taskPhase: "awaiting_input" as const, artifactId, startedAt: undefined }
          : message) : [...(ownedConversation?.messages ?? []),
          { id: createLocalId("user"), role: "user", content: prompt, time: currentTimeLabel() },
          { id: messageId, role: "assistant", content: "请选择要用于视频的图片。", status: "ready", taskPhase: "awaiting_input", artifactId, time: currentTimeLabel() }],
      };
      const artifact: TongpinAIArtifact = { id: artifactId, conversationId, projectId: conversation.projectId, title: "选择视频参考图片", kind: "参考图片选择", updatedLabel: "刚刚", summary: prompt, sections: [], data: {
        generatedImageSelection: selection as unknown as import("../../shared/aiWorkspace").AiWorkspaceJson,
      } };
      const currentState = { ...persistentStateRef.current, conversations: current.conversations, projects: current.projects,
        artifacts: [artifact, ...current.artifacts], drafts: current.drafts, draftAttachments: current.draftAttachments,
        videoDraftSettings: current.videoDraftSettings, activeProjectId: current.activeProjectId };
      const next = continuation ? { ...currentState, conversations: current.conversations.map(item => item.id === conversationId ? conversation : item) }
        : withPreparedChatSend(currentState, conversation, origin.draftKey);
      try { ensureAttachmentWorkspaceCapacity(next, "video"); }
      catch (error) { showAnnouncement(error instanceof Error ? error.message : "无法保存选图任务，原输入已保留"); return false; }
      pendingGenerationRef.current.add(conversationId);
      workspaceRef.current = { ...current, conversations: next.conversations, artifacts: next.artifacts, drafts: next.drafts,
        draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {},
        ...(!continuation ? { activeConversationId: conversationId, view: "chat" as const } : {}) };
      persistentStateRef.current = next;
      setConversations(next.conversations); setArtifacts(next.artifacts); setDrafts(next.drafts);
      setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
      if (!continuation) { setActiveConversationId(conversationId); setView("chat"); draftConversationIdsRef.current.delete(origin.draftKey); }
      const restoreUnrecordedSelection = async () => {
        if (!mountedRef.current) return;
        const latest = workspaceRef.current;
        const originalConversation = current.conversations.find(item => item.id === conversationId);
        const restoredConversations = originalConversation
          ? latest.conversations.map(item => item.id === conversationId ? originalConversation : item)
          : latest.conversations.filter(item => item.id !== conversationId);
        const restoredArtifacts = latest.artifacts.filter(item => item.id !== artifactId);
        const restoredDrafts = { ...latest.drafts, [origin.draftKey]: prompt };
        const restoredDraftAttachments = { ...latest.draftAttachments,
          ...(current.draftAttachments[origin.draftKey] ? { [origin.draftKey]: current.draftAttachments[origin.draftKey] } : {}) };
        const restoredVideoDraftSettings = { ...latest.videoDraftSettings,
          ...(current.videoDraftSettings[origin.draftKey] ? { [origin.draftKey]: current.videoDraftSettings[origin.draftKey] } : {}) };
        const backToDraft = !continuation && !originalConversation && latest.activeConversationId === conversationId;
        const restored = { ...persistentStateRef.current, conversations: restoredConversations, artifacts: restoredArtifacts,
          drafts: restoredDrafts, draftAttachments: restoredDraftAttachments, videoDraftSettings: restoredVideoDraftSettings,
          ...(backToDraft ? { activeConversationId: current.activeConversationId, view: current.view } : {}) };
        workspaceRef.current = { ...latest, ...restored };
        persistentStateRef.current = restored;
        setConversations(restoredConversations); setArtifacts(restoredArtifacts); setDrafts(restoredDrafts);
        setDraftAttachments(restoredDraftAttachments); setVideoDraftSettings(restoredVideoDraftSettings);
        if (backToDraft) { setActiveConversationId(current.activeConversationId); setView(current.view); draftConversationIdsRef.current.set(origin.draftKey, conversationId); }
        try { await persistenceRef.current.saveNow(restored); } catch { /* Keep the original draft locally if sync remains unavailable. */ }
      };
      try {
        if (!await persistenceRef.current.saveNow(next)) {
          await restoreUnrecordedSelection();
          showAnnouncement("选图任务尚未保存，原输入已保留；请先恢复同步。只选图片不会生成视频。");
          return false;
        }
        return true;
      } catch (error) {
        await restoreUnrecordedSelection();
        showAnnouncement(error instanceof Error ? error.message : "选图任务尚未保存，原输入已保留。");
        return false;
      } finally { pendingGenerationRef.current.delete(conversationId); }
    }
    const requestId = selectedImage?.requestId ?? videoRequest?.requestId ?? crypto.randomUUID();
    // Explicit composer references are part of this user turn too. Persist
    // the selected frame (or added image) before uploading a scoped reference.
    const submittedAttachments = kind === "video" && videoRequest?.referenceImages !== undefined
      ? videoReferenceDraftAttachments(videoRequest.referenceImages, `video-reference-${requestId}`, origin.attachments)
      : origin.attachments;
    const messageId = continuation?.messageId ?? createLocalId("assistant"), artifactId = selectedImage?.artifactId ?? `artifact-${requestId}`;
    const latest = workspaceRef.current;
    const ownedConversation = latest.conversations.find(item => item.id === conversationId) ?? origin.conversation;
    const conversation: TongpinAIConversation = {
      ...(ownedConversation ?? { id: conversationId, projectId: origin.project?.id, title: Array.from(prompt).slice(0, 28).join("") }),
      timeLabel: "刚刚", messages: continuation ? (ownedConversation?.messages ?? []).map(message => message.id === messageId
        ? { ...message, content: "", status: "ready" as const, taskPhase: "queued" as const, artifactId, requestId, startedAt: Date.now() }
        : message) : [...(ownedConversation?.messages ?? []),
        { id: createLocalId("user"), role: "user", content: prompt, time: currentTimeLabel(), ...(submittedAttachments.length ? { attachments: submittedAttachments } : {}) },
        // Keep the assistant placeholder out of the server's frozen conversation
        // context. The task card supplies live status; this saved turn preserves
        // the current user message as the final eligible context message.
        { id: messageId, role: "assistant", content: "", status: "ready", taskPhase: "queued", startedAt: Date.now(), artifactId, requestId, time: currentTimeLabel() }],
    };
    const artifact: TongpinAIArtifact = { id: artifactId, conversationId, projectId: conversation.projectId,
      title: kind === "video" ? "生成的视频" : "生成的图片", kind: kind === "video" ? "视频" : "图片", updatedLabel: "刚刚", summary: prompt, sections: [],
      data: { mediaTaskRequestId: requestId, mediaTaskStatus: "queued", ...(priorImageIds.length ? { mediaTaskSourceAssetIds: priorImageIds } : {}),
        ...(selectedImage ? { selectedGeneratedImage: { sourceArtifactId: selectedImage.sourceArtifactId, assetId: selectedImage.assetId } } : {}) } };
    const currentState = { ...persistentStateRef.current,
      conversations: latest.conversations, projects: latest.projects, artifacts: selectedImage
        ? latest.artifacts.map(item => item.id === artifactId ? artifact : item) : [artifact, ...latest.artifacts], drafts: latest.drafts,
      draftAttachments: latest.draftAttachments, videoDraftSettings: latest.videoDraftSettings, activeProjectId: latest.activeProjectId,
    };
    const next = continuation ? { ...currentState, conversations: latest.conversations.map(item => item.id === conversationId ? conversation : item) }
      : withPreparedChatSend(currentState, conversation, origin.draftKey);
    try { ensureAttachmentWorkspaceCapacity(next, kind === "video" ? "video" : "reply"); }
    catch (error) {
      if (error instanceof WorkspaceCapacityError) setCapacityNotice(error.message);
      else showAnnouncement(error instanceof Error ? error.message : "记录空间不足，未提交生成");
      return false;
    }
    pendingGenerationRef.current.add(conversationId);
    pendingCancelledRef.current.delete(conversationId);
    setReplyActivity(conversationId, messageId, "waiting");
    workspaceRef.current = { ...latest, conversations: next.conversations, artifacts: next.artifacts, drafts: next.drafts,
      draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {},
      ...(!continuation ? { activeConversationId: conversationId, view: "chat" as const } : {}) };
    persistentStateRef.current = next;
    setConversations(next.conversations); setArtifacts(next.artifacts); setDrafts(next.drafts);
    setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
    if (!continuation) { setActiveConversationId(conversationId); setView("chat"); draftConversationIdsRef.current.delete(origin.draftKey); }
    let postStarted = false;
    try {
      // A successful workspace CAS is required before any media source or paid task POST.
      if (!await persistenceRef.current.saveNow(next)) throw new Error("记录尚未保存，本次没有提交媒体任务。请恢复同步后重试。");
      if (pendingCancelledRef.current.has(conversationId)) throw new Error("已停止，本次未提交生成。");
      if (!mountedRef.current || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
      let sourceAssetIds: string[];
      let parameters: { model: NonNullable<VideoChatRequest["model"]>; seconds: number; resolution: VideoChatRequest["resolution"]; aspectRatio: VideoChatRequest["aspectRatio"]; referenceIds: string[] } | undefined;
      // A model-only dispatch is classification, not the member's paid action.
      // It may plan, but authorization must come from the task card.
      let maxPointsPerTool = continuation ? undefined : kind === "image" ? aiStatus?.imageQuotaTokens : suppliedVideoPoints;
      if (kind === "image") {
        sourceAssetIds = origin.attachments.length ? origin.attachments.map(item => item.id) : priorImageIds;
      } else {
        const list = await api<AiVideoList>(`/api/ai/videos?tier=${encodeURIComponent(origin.mode)}`, { headers: { "X-Tongpin-Account": user.id } });
        const migration = videoReferencesFromAttachments(origin.attachments);
        if (!migration.ok) throw new Error(migration.message);
        let references = videoRequest?.referenceImages ?? migration.images;
        if (selectedImage && origin.conversation) {
          const { extractMediaAttachment } = await import("../features/tongpin-ai/mediaAttachments");
          const generated = await generatedVideoReference(origin.conversation, workspaceRef.current.artifacts, prompt, api, user.id, new AbortController().signal, extractMediaAttachment,
            { sourceArtifactId: selectedImage.sourceArtifactId, assetId: selectedImage.assetId });
          if (!generated) throw new Error("选中的图片无法恢复，本次未提交视频生成。");
          references = [generated];
        } else if (!references.length && !origin.attachments.length && origin.conversation) {
          const { extractMediaAttachment } = await import("../features/tongpin-ai/mediaAttachments");
          const generated = await generatedVideoReference(origin.conversation, workspaceRef.current.artifacts, prompt, api, user.id, new AbortController().signal, extractMediaAttachment);
          if (generated) references = [generated];
          else if (/同一个人物|同一位人物|这张|上张|刚才.{0,8}(?:图|人物)|把[她他它]动起来/.test(prompt)) throw new Error("没有找到可验证的上一张图片，请先选择参考图；本次未生成视频。");
        }
        // Server profiles decide what the tier can run; an explicit member
        // choice is honored exactly, otherwise the tier default is used or the
        // replacement and its reason are recorded for the task card.
        const explicitRequest = videoRequest ? { ...videoRequest, ...(references.length ? { referenceImages: references } : {}) } : undefined;
        const natural = explicitRequest ? undefined
          : naturalVideoRequest(requestId, prompt, list.settings, selectedImage?.previousSettings ?? latest.videoDraftSettings[origin.draftKey], references);
        const prepared = explicitRequest ?? natural!.request;
        const videoChoice = explicitRequest ? explicitVideoChoice(list.settings, explicitRequest) : natural!.choice;
        if (!prepared.model || !list.settings.availableModels.includes(prepared.model)) throw new Error("当前档位没有可用的视频模型，请重新选择");
        if (!continuation && (!Number.isSafeInteger(maxPointsPerTool) || Number(maxPointsPerTool) <= 0)) maxPointsPerTool = list.settings.quotaPoints;
        sourceAssetIds = [...(prepared.referenceIds ?? [])];
        for (const image of prepared.referenceImages ?? []) {
          if (pendingCancelledRef.current.has(conversationId)) throw new Error("已停止，本次未提交生成。");
          if (!liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
          const ref = await api<{ id: string }>("/api/ai/video-references", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(videoReferenceUploadBody(image, conversationId)) });
          sourceAssetIds.push(ref.id);
        }
        parameters = { model: prepared.model, seconds: prepared.seconds, resolution: prepared.resolution, aspectRatio: prepared.aspectRatio, referenceIds: sourceAssetIds };
        const { referenceImages: _localImages, ...durableRequest } = prepared;
        const current = workspaceRef.current;
        const nextArtifacts = current.artifacts.map(item => item.id === artifactId ? { ...item, data: { ...item.data, videoRequest: persistedVideoChatRequest({ ...durableRequest, referenceIds: sourceAssetIds }) as unknown as import("../../shared/aiWorkspace").AiWorkspaceJson,
          videoChoice: videoChoice as unknown as import("../../shared/aiWorkspace").AiWorkspaceJson } } : item);
        const preparedState = { ...persistentStateRef.current, artifacts: nextArtifacts };
        ensureAttachmentWorkspaceCapacity(preparedState, "video");
        workspaceRef.current = { ...current, artifacts: nextArtifacts }; persistentStateRef.current = preparedState; setArtifacts(nextArtifacts);
        if (!await persistenceRef.current.saveNow(preparedState)) throw new Error("参考图片记录尚未保存，本次没有提交媒体任务");
      }
      if (pendingCancelledRef.current.has(conversationId)) throw new Error("已停止，本次未提交生成。");
      if (!mountedRef.current || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
      const body = { requestId, conversationId, entrypoint, tier: origin.mode, intent: kind, requestText: prompt,
        sourceAssetIds, ...(parameters ? { videoParameters: parameters } : {}),
        ...(Number.isSafeInteger(maxPointsPerTool) && Number(maxPointsPerTool) > 0 ? { confirmedMediaExecution: { confirmed: true, maxPointsPerTool } } : {}) };
      postStarted = true;
      const response = await api<unknown>("/api/ai/media-tasks", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(body) }, 80_000);
      const task = parseMediaTaskResponse(response, { requestId, conversationId, accountId: user.id, intent: kind });
      recordMediaTask(conversationId, requestId, task);
      return true;
    } catch (error) {
      if (!mountedRef.current) return true;
      const definite = !postStarted || error instanceof ApiRequestError && [400, 401, 402, 403, 404, 409, 413, 429].includes(error.status);
      if (!definite) {
        try {
          const response = await api<unknown>(`/api/ai/media-tasks/by-request/${encodeURIComponent(requestId)}`, { headers: { "X-Tongpin-Account": user.id } }, 30_000);
          const task = parseMediaTaskResponse(response, { requestId, conversationId, accountId: user.id, intent: kind });
          recordMediaTask(conversationId, requestId, task); return true;
        } catch { /* The original requestId remains durable for read-only recovery. */ }
      }
      if (definite) {
        const message = error instanceof Error ? error.message : "媒体任务未提交";
        const current = workspaceRef.current;
        const nextConversations = replaceChatMessage(current.conversations, conversationId, messageId, { status: "error", taskPhase: "failed", content: `本次未提交生成：${message}` });
        const nextArtifacts = current.artifacts.map(item => item.id === artifactId ? { ...item, data: { ...item.data, mediaTaskSubmitError: message, mediaTaskStatus: "failed" } } : item);
        const nextDrafts = { ...current.drafts, [conversationId]: prompt };
        const nextDraftAttachments = submittedAttachments.length ? { ...current.draftAttachments, [conversationId]: submittedAttachments } : current.draftAttachments;
        const failedState = { ...persistentStateRef.current, conversations: nextConversations, artifacts: nextArtifacts, drafts: nextDrafts, draftAttachments: nextDraftAttachments };
        workspaceRef.current = { ...current, conversations: nextConversations, artifacts: nextArtifacts, drafts: nextDrafts, draftAttachments: nextDraftAttachments };
        persistentStateRef.current = failedState; setConversations(nextConversations); setArtifacts(nextArtifacts); setDrafts(nextDrafts); setDraftAttachments(nextDraftAttachments);
        try { await persistenceRef.current.saveNow(failedState); } catch { /* Original draft remains visible locally. */ }
        showAnnouncement(message);
        return false;
      }
      updateReply(conversationId, messageId, { taskPhase: "unknown", content: "提交结果正在按原请求编号核对；不会再次发起付费请求。" });
      return true;
    } finally {
      pendingGenerationRef.current.delete(conversationId);
      pendingCancelledRef.current.delete(conversationId);
      if (mountedRef.current) { clearReplyActivity(conversationId, messageId); void refreshStatus(); }
    }
  }

  async function selectGeneratedImageForVideo(artifactId: string, assetId: string): Promise<boolean> {
    if (imageSelectionBusyRef.current.has(artifactId)) return false;
    const current = workspaceRef.current;
    const artifact = current.artifacts.find(item => item.id === artifactId);
    const selection = readGeneratedImageSelection(artifact);
    const conversation = current.conversations.find(item => item.id === artifact?.conversationId);
    const messageIndex = conversation?.messages.findIndex(item => item.role === "assistant" && item.artifactId === artifactId) ?? -1;
    const message = messageIndex < 0 ? undefined : conversation?.messages[messageIndex];
    const source = current.artifacts.find(item => item.id === selection?.sourceArtifactId && item.conversationId === conversation?.id && item.kind === "图片");
    if (!artifact || !conversation || current.activeConversationId !== conversation.id || !selection || selection.status !== "awaiting_selection"
      || !message || !selection.assetIds.includes(assetId) || !source || !conversation.messages.some(item => item.role === "assistant" && item.artifactId === source.id)
      || !Array.isArray(source.data?.images) || !source.data.images.some(item => item && typeof item === "object" && !Array.isArray(item) && !item.deleted && item.assetId === assetId)) {
      throw new Error("选中的图片已删除或不属于当前对话，本次未生成视频。");
    }
    if (conversationBusy(conversation.id)) throw new Error("这段对话正在处理其他任务，请稍后再选图片。");
    const userMessage = [...conversation.messages.slice(0, messageIndex)].reverse().find(item => item.role === "user");
    const snapshot = captureSubmission({ conversationId: conversation.id, draftKey: conversation.id, conversation,
      project: current.projects.find(item => item.id === conversation.projectId) ?? null,
      attachments: userMessage?.attachments ?? [], mode: selection.mode, skillIds: [], webSearch: false });
    const videoRequest: VideoChatRequest | undefined = selection.videoOptions ? {
      requestId: selection.requestId, prompt: artifact.summary, originalPrompt: artifact.summary,
      ...selection.videoOptions,
    } : undefined;
    imageSelectionBusyRef.current.add(artifactId);
    try {
      return await submitMediaTask("video", artifact.summary, videoRequest, selection.entrypoint, undefined,
        { conversationId: conversation.id, messageId: message.id, originalPrompt: artifact.summary, snapshot },
        { artifactId, requestId: selection.requestId, sourceArtifactId: selection.sourceArtifactId, assetId, previousSettings: selection.previousSettings });
    } finally { imageSelectionBusyRef.current.delete(artifactId); }
  }

  async function cancelGeneratedImageSelection(artifactId: string): Promise<void> {
    if (imageSelectionBusyRef.current.has(artifactId)) return;
    const current = workspaceRef.current;
    const artifact = current.artifacts.find(item => item.id === artifactId);
    const selection = readGeneratedImageSelection(artifact);
    const conversation = current.conversations.find(item => item.id === artifact?.conversationId);
    const message = conversation?.messages.find(item => item.role === "assistant" && item.artifactId === artifactId);
    if (!artifact || !selection || selection.status !== "awaiting_selection" || !conversation || !message || current.activeConversationId !== conversation.id) return;
    imageSelectionBusyRef.current.add(artifactId);
    try {
      const nextArtifacts = current.artifacts.map(item => item.id === artifactId ? {
        ...item, data: { ...item.data, generatedImageSelection: { ...selection, status: "cancelled" } as unknown as import("../../shared/aiWorkspace").AiWorkspaceJson },
      } : item);
      const nextConversations = replaceChatMessage(current.conversations, conversation.id, message.id, { content: "已取消选择，本次未生成视频。", taskPhase: "cancelled", status: "ready" });
      const next = { ...persistentStateRef.current, conversations: nextConversations, artifacts: nextArtifacts };
      workspaceRef.current = { ...current, conversations: nextConversations, artifacts: nextArtifacts };
      persistentStateRef.current = next;
      setConversations(nextConversations); setArtifacts(nextArtifacts);
      if (!await persistenceRef.current.saveNow(next)) {
        const latest = workspaceRef.current;
        const restoredArtifacts = latest.artifacts.map(item => item.id === artifactId ? artifact : item);
        const restoredConversations = replaceChatMessage(latest.conversations, conversation.id, message.id, { content: message.content, taskPhase: "awaiting_input", status: "ready" });
        workspaceRef.current = { ...latest, artifacts: restoredArtifacts, conversations: restoredConversations };
        persistentStateRef.current = { ...persistentStateRef.current, artifacts: restoredArtifacts, conversations: restoredConversations };
        setArtifacts(restoredArtifacts); setConversations(restoredConversations);
        throw new Error("取消选择尚未保存，请恢复同步后重试。");
      }
    } finally { imageSelectionBusyRef.current.delete(artifactId); }
  }

  async function sendVideo(request: import("../features/tongpin-ai/videoChat").VideoChatRequest, importOnly = false, continuation?: TaskContinuation): Promise<boolean> {
    const conversationId = continuation?.conversationId ?? requestConversationId();
    const origin = continuation?.snapshot ?? captureSubmission({ conversationId, draftKey, conversation: activeConversation, project: activeProject, attachments, mode, skillIds: [...enabledSkillIds], webSearch });
    if (!persona.profile.onboardingComplete || !continuation && (conversationBusy(conversationId) || preflightGate.busy)) return false;
    if (!importOnly && !request.planRequestId) { showAnnouncement("请先让同频 AI 整理视频任务，再确认生成"); return false; }
    if (origin.attachments.length) {
      const migration = videoReferencesFromAttachments(origin.attachments);
      if (!migration.ok) { showAnnouncement(migration.message); return false; }
    }
    if (persistenceRef.current.status === "error" || persistenceRef.current.status === "conflict") { showAnnouncement("请先完成记录同步，再生成视频"); return false; }
    if (origin.conversation && !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId)) return false;
    let preparedRequest = request;
    if (continuation && (!mountedRef.current || pendingCancelledRef.current.has(conversationId) || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, continuation.messageId))) return false;
    const ownedConversation = workspaceRef.current.conversations.find(item => item.id === conversationId) ?? origin.conversation;
    const messageId = continuation?.messageId ?? createLocalId("assistant"), artifactId = importOnly ? createLocalId("artifact") : `artifact-${request.requestId}`;
    const conversation: TongpinAIConversation = {
      ...(ownedConversation ?? { id: conversationId, projectId: origin.project?.id, title: Array.from(preparedRequest.prompt).slice(0, 28).join("") }),
      timeLabel: "刚刚", messages: [...(ownedConversation?.messages ?? []).filter(message => message.id !== messageId),
        ...(!continuation ? [{ id: createLocalId("user"), role: "user" as const, content: importOnly ? `查看原视频任务：${preparedRequest.prompt}` : preparedRequest.originalPrompt ?? preparedRequest.prompt, time: currentTimeLabel(), ...(!importOnly && origin.attachments.length ? { attachments: origin.attachments } : {}) }] : []),
        { id: messageId, role: "assistant", content: "视频生成任务", artifactId, status: "ready", time: currentTimeLabel(),
          ...(preparedRequest.planRequestId ? { requestId: preparedRequest.planRequestId, harnessPlanRequestId: preparedRequest.planRequestId } : {}),
          ...(preparedRequest.planTrace ? { trace: preparedRequest.planTrace } : {}) }],
    };
    const { referenceImages: _localReferenceImages, ...initialDurableRequest } = preparedRequest;
    const artifact: TongpinAIArtifact = { id: artifactId, conversationId, projectId: conversation.projectId,
      title: "生成的视频", kind: "视频", summary: preparedRequest.prompt, updatedLabel: "刚刚", sections: [], data: { videoJobId: preparedRequest.requestId,
        ...(preparedRequest.planRequestId ? { harnessPlanRequestId: preparedRequest.planRequestId } : {}),
        ...(!importOnly ? { videoRequest: JSON.parse(JSON.stringify(persistedVideoChatRequest(initialDurableRequest))) } : {}) } };
    const latest = workspaceRef.current;
    const videoBase = { ...persistentStateRef.current,
      conversations: latest.conversations, projects: latest.projects, drafts: latest.drafts,
      draftAttachments: latest.draftAttachments, videoDraftSettings: latest.videoDraftSettings, activeProjectId: latest.activeProjectId,
      artifacts: [artifact, ...latest.artifacts] };
    const next = continuation ? mergeContinuation(videoBase, conversation) : withPreparedChatSend(videoBase, conversation, origin.draftKey);
    if (importOnly) {
      next.drafts = draftKey === conversationId ? latest.drafts : { ...latest.drafts, [conversationId]: latest.drafts[draftKey] ?? "", [draftKey]: "" };
      next.draftAttachments = latest.draftAttachments;
      next.videoDraftSettings = latest.videoDraftSettings;
    }
    try { ensureAttachmentWorkspaceCapacity(next, "video"); }
    catch (e) {
      if (e instanceof WorkspaceCapacityError) setCapacityNotice(e.message);
      else showAnnouncement(e instanceof Error ? e.message : "记录空间不足");
      return false;
    }
    pendingGenerationRef.current.add(conversationId);
    pendingCancelledRef.current.delete(conversationId);
    setReplyActivity(conversationId, messageId, "waiting");
    workspaceRef.current = { ...latest, conversations: next.conversations, artifacts: next.artifacts, drafts: next.drafts,
      draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {}, ...(!continuation ? { activeConversationId: conversationId, view: "chat" as const } : {}) };
    persistentStateRef.current = next;
    setConversations(next.conversations); setArtifacts(next.artifacts); setDrafts(next.drafts);
    setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
    if (!continuation) { setActiveConversationId(conversationId); setView("chat"); draftConversationIdsRef.current.delete(origin.draftKey); }
    let posted = false;
    let keepComposerOpen = false;
    try {
      const saved = await persistenceRef.current.saveNow(next);
      if (!mountedRef.current) return true;
      if (!saved || pendingCancelledRef.current.has(conversationId)) {
        updateReply(conversationId, messageId, { status: "error", artifactId: undefined, content: !saved ? "记录尚未保存，本次没有提交视频生成。" : "已取消，本次没有提交视频生成。" }); return true;
      }
      if (!liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
      if (importOnly) return true;
      // The source video and explicit frame selection must be durable before
      // the server can bind an uploaded reference to this conversation.
      if (request.referenceImages?.length) {
        const referenceIds = [...(request.referenceIds ?? [])];
        for (const image of request.referenceImages) {
          const ref = await api<{ id: string }>("/api/ai/video-references", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(videoReferenceUploadBody(image, conversationId)) });
          referenceIds.push(ref.id);
        }
        const { referenceImages: _referenceImages, ...withoutLocalImages } = request;
        preparedRequest = { ...withoutLocalImages, referenceIds };
        if (pendingCancelledRef.current.has(conversationId) || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
        const current = workspaceRef.current;
        const updatedArtifacts = current.artifacts.map(item => item.id === artifactId
          ? { ...item, data: { ...item.data, videoRequest: JSON.parse(JSON.stringify(persistedVideoChatRequest(preparedRequest))) } }
          : item);
        const preparedState = { ...persistentStateRef.current, artifacts: updatedArtifacts };
        ensureAttachmentWorkspaceCapacity(preparedState, "video");
        workspaceRef.current = { ...current, artifacts: updatedArtifacts };
        persistentStateRef.current = preparedState;
        setArtifacts(updatedArtifacts);
        if (!await persistenceRef.current.saveNow(preparedState)) throw new Error("参考图片记录尚未保存，本次没有提交视频生成");
        if (pendingCancelledRef.current.has(conversationId) || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId, messageId)) return true;
      }
      const { referenceImages: _referenceImages, originalPrompt: _originalPrompt, planSummary: _planSummary, planTrace: _planTrace, ...wireRequest } = preparedRequest;
      posted = true;
      await api("/api/ai/videos", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(wireRequest) }, 80000);
      setVideoDispatchRequest(current => current?.conversationId === conversationId ? undefined : current);
    } catch (e) {
      if (mountedRef.current) {
        const rejected = !posted || e instanceof ApiRequestError && [400, 401, 402, 403, 409, 413, 429].includes(e.status);
        const message = e instanceof Error ? e.message : "视频未提交";
        if (rejected) {
          const current = workspaceRef.current;
          const nextConversations = replaceChatMessage(current.conversations, conversationId, messageId, { status: "ready", content: "视频未提交，原设置和参考图片已保留。" });
          const nextArtifacts = current.artifacts.map(item => item.id === artifactId ? { ...item, data: { ...item.data, videoSubmitError: message } } : item);
          const nextDraftAttachments = { ...current.draftAttachments, [conversationId]: videoReferenceDraftAttachments(request.referenceImages ?? [], `video-reference-${conversationId}`, origin.attachments) };
          const nextVideoDraftSettings = { ...current.videoDraftSettings, [conversationId]: {
            model: request.model, seconds: request.seconds, resolution: request.resolution, aspectRatio: request.aspectRatio,
          } };
          const nextDrafts = { ...current.drafts, [conversationId]: request.originalPrompt ?? request.prompt };
          const failedState = { ...persistentStateRef.current, conversations: nextConversations, artifacts: nextArtifacts,
            drafts: nextDrafts, draftAttachments: nextDraftAttachments, videoDraftSettings: nextVideoDraftSettings };
          workspaceRef.current = { ...current, conversations: nextConversations, artifacts: nextArtifacts,
            drafts: nextDrafts, draftAttachments: nextDraftAttachments, videoDraftSettings: nextVideoDraftSettings };
          persistentStateRef.current = failedState;
          setConversations(nextConversations); setArtifacts(nextArtifacts); setDrafts(nextDrafts);
          setDraftAttachments(nextDraftAttachments); setVideoDraftSettings(nextVideoDraftSettings);
          setVideoDispatchRequest({ id: crypto.randomUUID(), conversationId, prompt: request.originalPrompt ?? request.prompt, request });
          keepComposerOpen = true;
          try { await persistenceRef.current.saveNow(failedState); } catch { /* visible retry state remains local */ }
        } else updateReply(conversationId, messageId, { status: "ready", content: "提交结果正在核对，请勿重复生成。下方只查询原任务。" });
      }
    } finally {
      pendingGenerationRef.current.delete(conversationId);
      pendingCancelledRef.current.delete(conversationId);
      if (mountedRef.current) { clearReplyActivity(conversationId, messageId); void refreshStatus(); }
    }
    return !keepComposerOpen;
  }

  async function useVideoHistory(jobId: string): Promise<boolean> {
    const origin = workspaceRef.current;
    const { job } = await api<{ job: import("../../shared/aiVideo").AiVideoJob }>(`/api/ai/videos/${encodeURIComponent(jobId)}`, { headers: { "X-Tongpin-Account": user.id } }, 30000);
    if (!mountedRef.current || origin.activeConversationId !== workspaceRef.current.activeConversationId || origin.activeProjectId !== workspaceRef.current.activeProjectId || workspaceRef.current.view !== "chat") return false;
    return sendVideo({ requestId: job.id, prompt: job.prompt, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio }, true);
  }

  /** Publish the submitted turn synchronously, before any planning/provider IO.
   * Follow-up async work owns this snapshot, not a future active composer. */
  async function submitToolTask(kind: "text" | "image" | "presentation" | "video", prompt: string, videoRequest?: VideoChatRequest,
    entrypoint: "natural" | "mention_image" | "mention_video" | "menu" = "menu", maxPointsPerTool?: number): Promise<boolean> {
    if (kind === "image" || kind === "video") return submitMediaTask(kind, prompt, videoRequest, entrypoint, maxPointsPerTool);
    const conversationId = requestConversationId();
    if (!prompt.trim() || conversationBusy(conversationId) || !serviceConnected || quotaInsufficient || fileImportRef.current.has(draftKey)) return false;
    const snapshot = captureSubmission({ conversationId, draftKey, conversation: activeConversation, project: activeProject, attachments, mode, skillIds: [...enabledSkillIds], webSearch: false });
    const messageId = createLocalId("assistant");
    const conversation: TongpinAIConversation = {
      ...(snapshot.conversation ?? { id: conversationId, projectId: snapshot.project?.id, title: Array.from(prompt).slice(0, 28).join("") }),
      timeLabel: "刚刚",
      messages: [...(snapshot.conversation?.messages ?? []),
        { id: createLocalId("user"), role: "user", content: prompt, time: currentTimeLabel(), ...(snapshot.attachments.length ? { attachments: snapshot.attachments } : {}) },
        { id: messageId, role: "assistant", content: "", status: "thinking", taskPhase: "queued", startedAt: Date.now(), time: currentTimeLabel() }],
    };
    const latest = workspaceRef.current;
    const next = withPreparedChatSend({ ...persistentStateRef.current,
      conversations: latest.conversations, projects: latest.projects, artifacts: latest.artifacts, drafts: latest.drafts,
      draftAttachments: latest.draftAttachments, videoDraftSettings: latest.videoDraftSettings,
      activeConversationId: latest.activeConversationId, activeProjectId: latest.activeProjectId, view: latest.view,
    }, conversation, snapshot.draftKey);
    try { ensureAttachmentWorkspaceCapacity(next, "reply"); }
    catch (error) { showAnnouncement(error instanceof Error ? error.message : "无法保存任务，草稿已保留"); return false; }
    submissionSnapshotsRef.current.set(messageId, snapshot);
    pendingGenerationRef.current.add(conversationId);
    pendingCancelledRef.current.delete(conversationId);
    setReplyActivity(conversationId, messageId, "waiting");
    workspaceRef.current = { ...latest, conversations: next.conversations, drafts: next.drafts, draftAttachments: next.draftAttachments ?? {}, videoDraftSettings: next.videoDraftSettings ?? {}, activeConversationId: conversationId, view: "chat" };
    persistentStateRef.current = next;
    setConversations(next.conversations); setDrafts(next.drafts); setDraftAttachments(next.draftAttachments ?? {}); setVideoDraftSettings(next.videoDraftSettings ?? {});
    setActiveConversationId(conversationId); setView("chat"); draftConversationIdsRef.current.delete(snapshot.draftKey);
    const continuation: TaskContinuation = { conversationId, messageId, originalPrompt: prompt, snapshot };
    try {
      const recorded = persistenceRef.current.saveNow(next);
      if (kind === "text") {
        // Plain text needs no planning IO. Overlap the read-only quota preflight
        // with this first save instead of paying the two round trips serially.
        updateReply(conversationId, messageId, { taskPhase: "planning" });
        await sendMessage(undefined, { ...continuation, recorded });
        return true;
      }
      if (!await recorded) throw new Error("任务记录尚未保存，未调用模型。请恢复同步后重试。");
      if (!mountedRef.current || pendingCancelledRef.current.has(conversationId)) return true;
      updateReply(conversationId, messageId, { taskPhase: "planning" });
      const plan = await planTool(kind, prompt, videoRequest, continuation);
      if (plan && mountedRef.current && !pendingCancelledRef.current.has(conversationId)) await sendMessage({ ...plan, originalPrompt: prompt }, continuation);
    } catch (error) {
      if (mountedRef.current) updateReply(conversationId, messageId, { status: "error", content: error instanceof Error ? error.message : "任务规划失败，请重试" });
    } finally {
      pendingGenerationRef.current.delete(conversationId); pendingCancelledRef.current.delete(conversationId);
      if (mountedRef.current && !requestRef.current.has(conversationId)) clearReplyActivity(conversationId, messageId);
    }
    return true;
  }

  /** Steer: supplements typed while this conversation's reply ran, sent as ONE
   * follow-up text turn marked `supplement` (framed for the model server-side).
   * Owned by that conversation, never by the focused composer: consumes no
   * draft or attachment and never navigates. Resolves once the turn exists. */
  async function sendSupplementTurn(conversationId: string, text: string): Promise<SteerSendResult> {
    const conversation = liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId);
    if (!conversation) return { status: "failed", reason: "对话已删除，补充未发送" };
    const lastReply = latestAssistantMessage(conversation.messages);
    const blocked = supplementBlockReason({ onboarded: persona.profile.onboardingComplete, serviceConnected, connectionError: Boolean(connectionError), availabilityBlocked, quotaInsufficient,
      syncBlocked: persistenceRef.current.status === "error" || persistenceRef.current.status === "conflict", computerActive: computerRequest?.conversationId === conversationId,
      awaitingConfirmation: awaitingUserConfirmation(lastReply, workspaceRef.current.artifacts.find(item => item.id === lastReply?.artifactId && item.conversationId === conversationId)) });
    if (blocked) return { status: "failed", reason: blocked };
    if (conversationBusy(conversationId)) return { status: "retry" };
    const project = workspaceRef.current.projects.find(item => item.id === conversation.projectId) ?? null;
    const userMessage = { id: createLocalId("user"), role: "user" as const, content: text, time: currentTimeLabel() };
    try {
      // Read-only check first: a turn that cannot be sent leaves no trace in the conversation.
      const probe: AiChatRequest = { ...buildChatRequest(crypto.randomUUID(), mode, [...conversation.messages, userMessage]), conversationId,
        ...mentionedCapabilityRequest(text, [...enabledSkillIds]), projectContext: project?.instructions || undefined,
        attachments: toolAttachmentContext([], project?.contextDocuments ?? [], conversation.messages), outputFormat: "dispatch", webSearchMode: "auto", supplement: true };
      const preflight = await api<AiChatPreflight>("/api/ai/preflight", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(probe) });
      statusGenerationRef.current += 1;
      if (mountedRef.current) setAiStatus(current => current ? { ...current, quota: preflight.quota } : current);
      // Just after a stop the server may still finish the old request: wait, then retry.
      if (!preflight.canSend) return { status: preflight.reason === "request_in_progress" ? "retry" : "failed", reason: preflightNotice(preflight).message };
    } catch (error) { return { status: "failed", reason: error instanceof Error ? error.message : "额度暂时无法核对，补充内容已放回输入框" }; }
    const latest = workspaceRef.current;
    const current = mountedRef.current ? liveConversation(latest, deletingConversationRef.current, conversationId) : undefined;
    if (!current) return { status: "failed", reason: "对话已删除，补充未发送" };
    if (conversationBusy(conversationId)) return { status: "retry" };
    const messageId = createLocalId("assistant");
    const next = mergeContinuation({ ...persistentStateRef.current, conversations: latest.conversations }, { ...current, timeLabel: "刚刚",
      messages: [...current.messages, userMessage, { id: messageId, role: "assistant", content: "", status: "thinking", taskPhase: "queued", startedAt: Date.now(), time: currentTimeLabel() }] });
    try { ensureAttachmentWorkspaceCapacity(next, "reply"); }
    catch (error) { return { status: "failed", reason: error instanceof Error ? error.message : "保存空间不足，补充内容已放回输入框" }; }
    const snapshot = captureSubmission({ conversationId, draftKey: conversationId, conversation: current, project, attachments: [], mode, skillIds: [...enabledSkillIds], webSearch: false });
    submissionSnapshotsRef.current.set(messageId, snapshot);
    pendingGenerationRef.current.add(conversationId);
    pendingCancelledRef.current.delete(conversationId);
    setReplyActivity(conversationId, messageId, "waiting");
    workspaceRef.current = { ...latest, conversations: next.conversations };
    persistentStateRef.current = next;
    setConversations(next.conversations);
    const recorded = persistenceRef.current.saveNow(next);
    void (async () => {
      try {
        updateReply(conversationId, messageId, { taskPhase: "planning" });
        await sendMessage(undefined, { conversationId, messageId, originalPrompt: text, snapshot, recorded, supplement: true });
        // sendMessage may bail out before any request (stopped, sync lost…): never leave it
        // spinning. Its own failure path may already have marked it and refilled the composer.
        const owner = liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId);
        if (mountedRef.current && owner && !owner.messages.find(item => item.id === messageId)?.requestId) {
          setConversations(current => current.find(item => item.id === conversationId)?.messages.some(item => item.id === messageId && !item.requestId && item.status === "thinking")
            ? replaceChatMessage(current, conversationId, messageId, { status: "stopped", content: "补充未发送，本次未调用模型。" }) : current);
          setDrafts(current => current[conversationId]?.trim() ? current : { ...current, [conversationId]: text });
        }
      } catch (error) {
        if (mountedRef.current) updateReply(conversationId, messageId, { status: "error", content: error instanceof Error ? error.message : "补充发送失败，请重试" });
      } finally {
        pendingGenerationRef.current.delete(conversationId); pendingCancelledRef.current.delete(conversationId);
        if (mountedRef.current && !requestRef.current.has(conversationId)) clearReplyActivity(conversationId, messageId);
      }
    })();
    return { status: "sent" };
  }

  async function sendMessage(approvedPlan?: AiToolPlan & { originalPrompt: string }, continuation?: TaskContinuation) {
    const generationTool = approvedPlan?.kind === "image" || approvedPlan?.kind === "presentation" ? approvedPlan.kind : continuation?.supplement ? "text" : composerTool;
    if (!persona.profile.onboardingComplete || !continuation && (!draft.trim() && !attachments.length || preflightGate.busy || fileImportRef.current.has(draftKey)) || quotaInsufficient || !serviceConnected || connectionError || availabilityBlocked) return;
    const originId = continuation?.conversationId ?? activeConversationId;
    if (originId && !liveConversation(workspaceRef.current, deletingConversationRef.current, originId)) {
      showAnnouncement("此对话正在删除或已被删除，请选择其他对话"); return;
    }
    if (persistence.status === "conflict" || persistence.status === "error") { showAnnouncement("请先完成记录同步，再发送消息"); return; }
    const conversationId = continuation?.conversationId ?? requestConversationId();
    const origin = continuation?.snapshot ?? captureSubmission({ conversationId, draftKey, conversation: activeConversation, project: activeProject, attachments, mode, skillIds: [...enabledSkillIds], webSearch });
    if (generationTool === "image" && (!aiStatus?.imageEnabled || origin.webSearch)) {
      showAnnouncement(!aiStatus?.imageEnabled ? "请管理员先配置图片生成功能" : "图片生成暂不支持联网，请关闭搜索后重试"); return;
    }
    if (origin.webSearch && !aiStatus?.webSearchEnabled) { showAnnouncement("请关闭联网搜索，或联系管理员启用"); return; }
    if (generationTool === "image" && (!approvedPlan || approvedPlan.kind !== "image")) { showAnnouncement("图片生成需要先完成 AI 规划"); return; }
    if (generationTool === "presentation" && (!approvedPlan || approvedPlan.kind !== "presentation" || !approvedPlan.planRequestId)) { showAnnouncement("PPT 生成需要先完成 AI 规划"); return; }
    if (!continuation && conversationBusy(conversationId)) return;
    const content = (continuation?.originalPrompt ?? approvedPlan?.originalPrompt ?? draft.trim()) || "请分析附件中的内容。视频仅需分析提供的采样画面，不推测未提供的声音和画面。";
    // A direct computer instruction on a tier without the computer capability
    // gets the same tier notice as @computer, before any model call.
    const computerTierBlock = !continuation && !approvedPlan && generationTool === "text" && computerOperationIntent(content) ? computerTierNotice(aiStatus?.computerTiers, origin.mode) : null;
    if (computerTierBlock) { showAnnouncement(computerTierBlock, 9_000); return; }
    const messageId = continuation?.messageId ?? createLocalId("assistant");
    const requestId = crypto.randomUUID();
    const continuedConversation = continuation ? workspaceRef.current.conversations.find(item => item.id === conversationId) : undefined;
    const messages = continuation
      ? (continuedConversation?.messages ?? []).filter(message => message.id !== messageId)
      : [...(activeConversation?.messages ?? []), { id: createLocalId("user"), role: "user" as const, content, time: currentTimeLabel(), ...(attachments.length ? { attachments } : {}) }];
    let request: GenerationRequest;
    try {
      // Prior attachments stay as untrusted source material for follow-up questions.
      const documentPayload = generationTool === "image"
        ? imageReferencesForGeneration(origin.attachments, aiStatus?.imageEditTiers, origin.mode)
        : toolAttachmentContext(origin.attachments, origin.project?.contextDocuments ?? [], continuation ? messages : origin.conversation?.messages ?? []);
      if (generationTool !== "image" && documentPayload.some(item => item.dataUrl) && !aiStatus?.visionEnabled) throw new Error("管理员尚未启用图片理解，请联系管理员启用支持视觉输入的模型");
      const requestMessages = generationTool === "presentation" && approvedPlan
        ? [...messages.slice(0, -1), { ...messages[messages.length - 1], content: approvedPlan.prompt }]
        : messages;
      const capabilityRequest = generationTool === "image" ? undefined : mentionedCapabilityRequest(content, origin.skillIds);
      request = generationTool === "image" ? {
        requestId,
        conversationId,
        prompt: approvedPlan!.prompt,
        ...(approvedPlan!.planRequestId ? { planRequestId: approvedPlan!.planRequestId } : {}),
        ...(origin.project?.instructions ? { projectContext: origin.project.instructions } : {}),
        ...(documentPayload.length ? { attachments: documentPayload } : {}),
      } : {
        ...buildChatRequest(requestId, origin.mode, requestMessages), conversationId,
        ...capabilityRequest,
        projectContext: origin.project?.instructions || undefined,
        attachments: documentPayload, outputFormat: generationTool === "presentation" ? "presentation" : generationTool === "text" ? "dispatch" : "text",
        ...(generationTool === "presentation" ? { toolPlanRequestId: approvedPlan!.planRequestId } : {}), webSearchMode: "auto",
        ...(continuation?.supplement ? { supplement: true as const } : {}),
      };
    } catch (error) { showAnnouncement(error instanceof Error ? error.message : "内容超出限制"); return; }
    // Check before saving a sent message, clearing the draft or calling a provider.
    // The server checks again atomically when reserving the actual request budget.
    if (!("prompt" in request)) {
      // Once a turn has been queued it no longer belongs to the current input.
      // A local per-turn gate avoids A's preflight blocking/cancelling B.
      const gate = continuation ? new ChatPreflightGate() : preflightGate;
      const taskContext = continuation ? [continuation] : sendContextRef.current;
      const ticket = gate.start(taskContext);
      if (!ticket) return;
      const { context, controller } = ticket;
      const current = () => mountedRef.current && gate.isCurrent(ticket, continuation ? taskContext : sendContextRef.current) && !pendingCancelledRef.current.has(conversationId);
      if (!continuation) { setCheckingQuota(true); setBudgetNotice(null); }
      try {
        const media = origin.attachments.some(item => item.media)
          ? generatedMediaForMixedFollowup(origin.conversation, workspaceRef.current.artifacts, content)
          : generatedMediaForFollowup(origin.conversation, workspaceRef.current.artifacts, content);
        if (media) {
          if (!aiStatus?.visionEnabled) throw new Error("当前模型未开启视觉理解，请管理员启用后继续讨论视频或图片。草稿已保留。");
          assertGeneratedMediaCapacity(documentAttachments(origin.attachments));
          const { extractMediaAttachment } = await import("../features/tongpin-ai/mediaAttachments");
          const visual = await readGeneratedMedia(media, api, user.id, mediaCacheScope(session), controller.signal, extractMediaAttachment);
          if (!current()) return;
          request.attachments = toolAttachmentContext(origin.attachments, origin.project?.contextDocuments ?? [], continuation ? messages : origin.conversation?.messages ?? [], visual);
        }
        // Quick-tier text turns carry the local OpenSquilla decision to preflight and send alike.
        await attachOpenSquillaRoute(request, conversationId, messages);
        if (!current()) return;
        const result = await api<AiChatPreflight>("/api/ai/preflight", {
          method: "POST", body: JSON.stringify(request), signal: controller.signal,
          headers: { "X-Tongpin-Account": user.id },
        });
        if (!current()) return;
        statusGenerationRef.current += 1;
        setAiStatus(current => current ? { ...current, quota: result.quota } : current);
        if (!result.canSend) {
          if (continuation) throw new Error(preflightNotice(result).message);
          setBudgetNotice({ context, result }); return;
        }
      } catch (error) {
        if (current()) {
          const message = error instanceof Error ? error.message : "额度暂时无法核对，请重试。草稿已保留。";
          if (continuation) {
            updateReply(conversationId, messageId, { status: "error", content: message });
            // Never replace a newer draft that the user already started in A.
            setDrafts(drafts => drafts[conversationId]?.trim() ? drafts : { ...drafts, [conversationId]: continuation.originalPrompt });
            setDraftAttachments(drafts => drafts[conversationId]?.length ? drafts : { ...drafts, [conversationId]: origin.attachments });
          } else showAnnouncement(message);
        }
        return;
      } finally {
        if (gate.finish(ticket) && !continuation && mountedRef.current) setCheckingQuota(false);
      }
    }
    // The submitted turn must be durable before the reply is persisted or a model is called.
    if (continuation?.recorded && !await continuation.recorded) throw new Error("任务记录尚未保存，未调用模型。请恢复同步后重试。");
    if (continuation && (!mountedRef.current || pendingCancelledRef.current.has(conversationId))) return;
    if (originId && !liveConversation(workspaceRef.current, deletingConversationRef.current, originId)) {
      showAnnouncement("此对话正在删除或已被删除，本次未发送"); return;
    }
    if (persistenceRef.current.status === "conflict" || persistenceRef.current.status === "error") {
      showAnnouncement("请先完成记录同步，再发送消息。草稿已保留。"); return;
    }
    const latest = workspaceRef.current;
    const pendingReply = { id: messageId, requestId, role: "assistant" as const, content: "", status: "thinking" as const, startedAt: continuedConversation?.messages.find(message => message.id === messageId)?.startedAt ?? Date.now(), time: currentTimeLabel(),
      ...(approvedPlan?.planRequestId ? { harnessPlanRequestId: approvedPlan.planRequestId } : {}),
      ...(approvedPlan?.trace ? { trace: approvedPlan.trace } : {}) };
    const conversation: TongpinAIConversation = continuation
      ? { ...continuedConversation!, timeLabel: "刚刚", messages: [...messages, pendingReply] }
      : { ...(activeConversation ?? { id: conversationId, projectId: activeProject?.id, title: Array.from(content.split("\n")[0]).slice(0, 28).join("") }), timeLabel: "刚刚", messages: [...messages, pendingReply] };
    const baseState = { ...persistentStateRef.current,
      conversations: latest.conversations, projects: latest.projects, artifacts: latest.artifacts,
      drafts: latest.drafts, draftAttachments: latest.draftAttachments, videoDraftSettings: latest.videoDraftSettings, activeProjectId: latest.activeProjectId };
    const nextState = continuation
      ? mergeContinuation(baseState, conversation)
      : withPreparedChatSend(baseState, conversation, draftKey);
    try { ensureAttachmentWorkspaceCapacity(nextState, "reply"); setCapacityNotice(null); }
    catch (error) {
      if (error instanceof WorkspaceCapacityError) setCapacityNotice(error.message);
      else showAnnouncement(error instanceof Error ? error.message : "保存空间不足，草稿已保留");
      return;
    }
    pendingGenerationRef.current.add(conversationId);
    submissionSnapshotsRef.current.set(messageId, origin);
    pendingCancelledRef.current.delete(conversationId);
    setReplyActivity(conversationId, messageId, "waiting");
    workspaceRef.current = { ...latest, conversations: nextState.conversations, drafts: nextState.drafts,
      draftAttachments: nextState.draftAttachments ?? {}, videoDraftSettings: nextState.videoDraftSettings ?? {}, ...(!continuation ? { activeConversationId: conversationId, view: "chat" as const } : {}) };
    persistentStateRef.current = nextState;
    setConversations(nextState.conversations);
    if (!continuation) { setActiveConversationId(conversationId); setView("chat"); }
    setDrafts(nextState.drafts);
    setDraftAttachments(nextState.draftAttachments ?? {});
    setVideoDraftSettings(nextState.videoDraftSettings ?? {});
    if (!continuation) draftConversationIdsRef.current.delete(origin.draftKey);
    const saved = await persistenceRef.current.saveNow(nextState);
    if (!mountedRef.current) { pendingGenerationRef.current.delete(conversationId); return; }
    if (pendingCancelledRef.current.has(conversationId)) {
      pendingGenerationRef.current.delete(conversationId); pendingCancelledRef.current.delete(conversationId); clearReplyActivity(conversationId, messageId);
      updateReply(conversationId, messageId, { status: "stopped", content: "已取消发送，本次未调用模型。" }); return;
    }
    if (!saved) {
      clearReplyActivity(conversationId, messageId);
      retryRequestsRef.current.set(messageId, { conversationId, request });
      updateReply(conversationId, messageId, { status: "error", content: "记录尚未保存，请恢复同步后重新获取回复。本次尚未调用模型。" });
      pendingGenerationRef.current.delete(conversationId);
      return;
    }
    if (!workspaceRef.current.conversations.some(item => item.id === conversationId && item.messages.some(message => message.id === messageId))) {
      pendingGenerationRef.current.delete(conversationId); clearReplyActivity(conversationId, messageId); return;
    }
    try { await performChat(conversationId, messageId, request); }
    finally { pendingGenerationRef.current.delete(conversationId); pendingCancelledRef.current.delete(conversationId); }
  }

  async function retryReply(messageId: string, retryMode?: "continue" | "regenerate") {
    if (preflightGate.busy) return;
    if (retryMode) {
      const latest = workspaceRef.current;
      const owner = latest.conversations.find(item => item.messages.some(message => message.id === messageId));
      const message = owner?.messages.find(item => item.id === messageId);
      if (!owner || !message?.requestId || conversationBusy(owner.id)) return;
      if (retryMode === "continue" && !message.completion?.canContinue) return;
      const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: owner.id, mode, messages: [{ role: "user", content: retryMode === "continue" ? "请从断点继续完成回复。" : "请重新生成上一条回复。" }], retryOf: message.requestId, retryMode };
      const replyId = createLocalId("assistant");
      const nextConversation: TongpinAIConversation = { ...owner, messages: [...owner.messages, { id: replyId, requestId: request.requestId, role: "assistant", content: "", status: "thinking", startedAt: Date.now(), time: currentTimeLabel(), taskPhase: "queued" }] };
      const next = mergeContinuation({ ...persistentStateRef.current, conversations: latest.conversations }, nextConversation);
      workspaceRef.current = { ...latest, conversations: next.conversations }; persistentStateRef.current = next;
      setConversations(next.conversations); setReplyActivity(owner.id, replyId, "waiting"); pendingGenerationRef.current.add(owner.id);
      try { if (await persistenceRef.current.saveNow(next)) await performChat(owner.id, replyId, request); else updateReply(owner.id, replyId, { status: "error", content: "记录尚未保存，本次没有重新提交。" }); }
      finally { pendingGenerationRef.current.delete(owner.id); clearReplyActivity(owner.id, replyId); }
      return;
    }
    const retry = retryRequestsRef.current.get(messageId);
    if (retry) {
      if (conversationBusy(retry.conversationId)) return;
      if (!liveConversation(workspaceRef.current, deletingConversationRef.current, retry.conversationId, messageId)) return;
      if (persistence.status === "error" || persistence.status === "conflict") { showAnnouncement("请先恢复记录同步"); return; }
      pendingGenerationRef.current.add(retry.conversationId); pendingCancelledRef.current.delete(retry.conversationId);
      setReplyActivity(retry.conversationId, messageId, "waiting");
      try {
        const saved = await persistence.flushSaved();
        if (saved && mountedRef.current && !pendingCancelledRef.current.has(retry.conversationId)) await performChat(retry.conversationId, messageId, retry.request);
        else clearReplyActivity(retry.conversationId, messageId);
      } finally { pendingGenerationRef.current.delete(retry.conversationId); pendingCancelledRef.current.delete(retry.conversationId); }
      return;
    }
    const conversation = workspaceRef.current.conversations.find(item => item.messages.some(message => message.id === messageId));
    const message = conversation?.messages.find(item => item.id === messageId);
    if (!conversation || !message?.requestId || !liveConversation(workspaceRef.current, deletingConversationRef.current, conversation.id, messageId)) return;
    if (conversationBusy(conversation.id)) return;
    await performChat(conversation.id, messageId, message.requestId);
  }

  function stopResponse() {
    if (!activeConversationId) return;
    const typing = typingRef.current.get(activeConversationId);
    if (typing) { typing.finish(); return; }
    const request = requestRef.current.get(activeConversationId);
    if (pendingGenerationRef.current.has(activeConversationId) && !request) {
      pendingCancelledRef.current.add(activeConversationId);
      return;
    }
    // 多 Agent 协作 also stops its in-flight sub-agents on the server.
    if (request) void requestMultiAgentStop(api, user.id, workspaceRef.current.conversations.find(item => item.id === activeConversationId)?.messages.find(message => message.id === request.messageId)?.requestId);
    request?.controller.abort();
  }

  // Steer: supplements typed while a reply runs (lifecycle in steerController.ts).
  const steerGuidance = useMemo(() => runGuidanceClient(api, user.id), [api, user.id]);
  // A streaming reply's live process (e.g. its 多 Agent 协作 step) sits beside the
  // conversation until it settles; steering reads the reply as it is rendered.
  const withLiveReply = <T extends { id: string }>(message: T): T => streamReplies[message.id] ? { ...message, liveProcess: streamReplies[message.id].liveProcess } : message;
  const steer = useSteerController({
    sendFollowUp: sendSupplementTurn,
    restoreDraft: (conversationId, text, reason) => {
      // A draft keyed by a deleted conversation would make every later save fail.
      if (!liveConversation(workspaceRef.current, deletingConversationRef.current, conversationId)) { showAnnouncement("对话已删除，补充未发送", 6_000); return; }
      setDrafts(current => ({ ...current, [conversationId]: appendDraftText(current[conversationId], text) }));
      showAnnouncement(reason, 6_000);
    },
    recordDelivered: (conversationId, text) => setConversations(current => current.map(conversation => conversation.id === conversationId
      ? { ...conversation, messages: [...conversation.messages, { id: createLocalId("user"), role: "user" as const, content: text, time: currentTimeLabel() }] } : conversation)),
    isResponding: conversationBusy,
    isRunActive: (conversationId, runRequestId) => steerRunActive(workspaceRef.current.conversations.find(item => item.id === conversationId)?.messages.map(withLiveReply), runRequestId),
    notify: message => showAnnouncement(message),
    guidance: steerGuidance,
  });
  useEffect(() => { steer.sync(); }, [steer, conversationActivity, conversations]);
  const activeReply = latestAssistantMessage(activeConversation?.messages);
  // No steering while a confirmation card waits for the member.
  const steerAllowed = Boolean(activeConversation) && !awaitingUserConfirmation(activeReply, activeReply?.artifactId ? artifactById.get(activeReply.artifactId) : undefined);
  function addSupplement(conversationId: string, text: string): boolean {
    // A streaming Pro 多 Agent 协作 reply takes it as run guidance at its next checkpoint.
    const reply = latestAssistantMessage(workspaceRef.current.conversations.find(item => item.id === conversationId)?.messages);
    const added = steer.add(conversationId, text, steerDeliveryTarget(reply && withLiveReply(reply)));
    if (!added.ok) showAnnouncement(added.reason);
    return added.ok;
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
      aria-label="同频 AI 工作台"
    >
      {(capacityNotice || persistence.status === "error" || persistence.status === "conflict") && <div className="tp-ai-workspace-notices">
      {(persistence.status === "error" || persistence.status === "conflict") && <div className="tp-ai-sync-error" role="alert">
        <span>{persistence.error}{persistence.status === "error" && persistence.autoRetrying ? "（网络恢复后会自动重试保存）" : ""}</span>
        {persistence.status === "error" && <button type="button" onClick={persistence.retry}>重试保存</button>}
        <button type="button" onClick={exportWorkspace}>导出当前内容</button>
        {persistence.status === "conflict" && <button type="button" onClick={() => {
          if (window.confirm("请先导出当前内容。重新加载后将显示云端记录，是否继续？")) window.location.reload();
        }}>重新加载云端</button>}
      </div>}
      {capacityNotice && <div className="tp-ai-capacity-notice" role="alert">
        <span>{capacityNotice}</span>
        <button type="button" onClick={exportWorkspace}>导出当前内容</button>
        <button type="button" onClick={() => setCapacityNotice(null)} aria-label="关闭存储空间提示">关闭</button>
        <WorkspaceStorageRelief items={largestConversations} onDelete={openDeleteConversationDialog}
          onExportThenDelete={id => void exportConversationThenDelete(id)} />
      </div>}
      {!capacityNotice && persistence.status === "error" && isWorkspaceSpaceRejection(persistence.errorCode) && largestConversations.length > 0 && <div className="tp-ai-capacity-notice" role="status">
        <span>云端资料空间不足，本次改动尚未保存。可删除下面占用较多的对话后点“重试保存”。</span>
        <WorkspaceStorageRelief items={largestConversations} onDelete={openDeleteConversationDialog}
          onExportThenDelete={id => void exportConversationThenDelete(id)} />
      </div>}
      </div>}
      <TongpinAISidebar
        activeConversationId={activeConversationId}
        activeProjectId={activeProjectId}
        conversations={conversations}
        conversationStatuses={sidebarTaskStatuses}
        projects={projects}
        skillCount={TONGPIN_AI_SKILLS.length}
        usage={usage}
        workspaceStorage={persistence.storage}
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
          onApplySkillSet={(skillIds) => {
            setEnabledSkillIds(new Set(skillIds));
            showAnnouncement("Hub 已应用到 AI 工作台");
          }}
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
          viewerId={user.id}
          assistantName={persona.profile.name || "同频 AI"}
          characterExpression={persona.profile.expression}
          characterPaused={personaSettingsOpen}
          onEditPersona={() => setPersonaSettingsOpen(true)}
          artifactById={artifactById}
          composerFocusRequest={composerFocusRequest}
          conversationId={activeConversation?.id}
          conversationTitle={activeConversation?.title}
          projectId={activeProject?.id}
          projectContext={activeProject?.instructions}
          projectDocuments={activeProject?.contextDocuments}
          draft={draft}
          attachments={attachments}
          onAddFiles={addFiles}
          onRemoveAttachment={index => setDraftAttachments(current => ({ ...current, [draftKey]: attachments.filter((_, itemIndex) => itemIndex !== index) }))}
          onSelectVideoFrame={(attachmentIndex, frameIndex) => {
            const selected = attachments[attachmentIndex];
            if (selected?.media?.kind !== "video" || !Number.isInteger(frameIndex) || !selected.media.frames[frameIndex]) return;
            setDraftAttachments(current => ({ ...current, [draftKey]: (current[draftKey] ?? []).map((document, index) => index === attachmentIndex && document.media?.kind === "video" && document.media.frames[frameIndex] ? { ...document, media: { ...document.media, selectedFrameIndex: frameIndex } } : document) }));
            setAnnouncement(current => current.startsWith("请先在视频附件中选择一个采样画面") ? "" : current);
          }}
          composerTool={composerTool}
          onComposerToolChange={setComposerTool}
          imageEnabled={aiStatus?.imageEnabled === true}
          imageEditEnabled={aiStatus?.imageEditTiers?.includes(mode) === true}
          visionEnabled={aiStatus?.visionEnabled === true}
          quickAuto={aiStatus?.quickAgent === true}
          webSearchEnabled={aiStatus?.webSearchEnabled === true && !(mode === "quick" && aiStatus.quickAgent === true)}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
          enabledSkills={TONGPIN_AI_SKILLS.filter((skill) =>
            enabledSkillIds.has(skill.id),
          )}
          messages={activeConversation?.messages.map(message => streamReplies[message.id] ? { ...message, ...streamReplies[message.id] } : message) ?? []}
          mode={mode}
          notificationUnread={notificationToolbar?.unread ?? 0}
          projectTitle={activeProject?.title}
          quotaInsufficient={quotaInsufficient}
          checkingQuota={checkingQuota}
          budgetNotice={visibleBudgetNotice}
          onDisableSearch={() => { setWebSearch(false); setBudgetNotice(null); setComposerFocusRequest(value => value + 1); }}
          responding={responding}
          responsePhase={responsePhase}
          connectionLoading={connectionLoading}
          availabilityBlocked={availabilityBlocked}
          availabilityNotice={<AiAvailabilityNotice checking={availability.checking} check={availabilityCheck} onRetry={() => { void availability.refresh(availabilityScope); void refreshStatus(); }} />}
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
          onSubmit={plan => plan ? void sendMessage(plan) : void submitToolTask("text", draft.trim() || "请分析附件中的内容。视频仅需分析提供的采样画面，不推测未提供的声音和画面。")}
          onSubmitTool={(kind, prompt, entrypoint) => { void submitToolTask(kind, prompt, undefined, entrypoint); }}
          onPlanTool={planTool}
          onSubmitVideo={sendVideo}
          onSubmitVideoTask={(request, maxPointsPerTool) => submitToolTask("video", request.originalPrompt ?? request.prompt, request, "menu", maxPointsPerTool)}
          onUseVideoHistory={useVideoHistory}
          onMediaTask={recordMediaTask}
          onSelectGeneratedImage={selectGeneratedImageForVideo}
          onCancelGeneratedImageSelection={cancelGeneratedImageSelection}
          videoDispatchRequest={activeVideoDispatchRequest}
          computerAvailable={computerBridgeAvailable}
          computerRequest={computerRequest ? { id: computerRequest.id, originalPrompt: computerRequest.originalPrompt } : undefined}
          onOpenComputer={beginComputerUse}
          computerPanel={computerRequest ? <ComputerRunPanel key={computerRequest.id} accountId={user.id} api={api}
            request={{ id: computerRequest.id, conversationId: computerRequest.conversationId, mode: computerRequest.mode, instruction: computerRequest.originalPrompt, ...(computerRequest.contextHint ? { contextHint: computerRequest.contextHint } : {}) }}
            onQuota={quota => { statusGenerationRef.current += 1; setAiStatus(current => current ? { ...current, quota } : current); }}
            onFinish={result => recordComputerResult(result.summary)} onClose={closeComputerUse} /> : undefined}
          onStop={stopResponse}
          pendingSupplements={steer.bubbles(activeConversation?.id)}
          onSteer={steerAllowed && activeConversation ? text => addSupplement(activeConversation.id, text) : undefined}
          onCancelSupplement={id => steer.cancel(id)}
          onRetry={retryReply}
          onTraceChange={(messageId, trace) => {
            if (activeConversation) updateHarnessTrace(activeConversation.id, messageId, trace);
          }}
          onMessageVisible={messageId => {
            const state = workspaceRef.current;
            if (document.hidden || personaSettingsOpen || state.view !== "chat" || !state.activeConversationId) return;
            const owner = state.conversations.find(item => item.id === state.activeConversationId);
            const message = owner?.messages.find(item => item.id === messageId);
            if (!owner || !message) return;
            const task = messageTaskStatus(message, state.artifacts.find(item => item.id === message.artifactId && item.conversationId === owner.id));
            if (task?.phase !== "completed" || !task.resultToken) return;
            const latest = conversationTaskStatus(owner, state.artifacts);
            if (latest?.resultToken !== task.resultToken) return;
            setSeenResults(current => {
              if (current[owner.id] === task.resultToken) return current;
              const next = { ...current, [owner.id]: task.resultToken! }; saveSeenResults(user.id, next); return next;
            });
          }}
          retryableMessageIds={new Set([...retryRequestsRef.current.keys(), ...conversations.flatMap(item => item.messages.filter(message => message.status === "error" && message.requestId && message.retryDisposition).map(message => message.id))])}
        />
      )}

      {view === "chat" && artifactOpen && activeArtifact ? (
        <ArtifactPreview
          artifact={activeArtifact}
          onClose={() => setArtifactOpen(false)}
          onImageDeleted={assetId => setArtifacts(current => current.map(artifact => !Array.isArray(artifact.data?.images) ? artifact : { ...artifact, data: { ...artifact.data, images: artifact.data.images.map(image => image && typeof image === "object" && !Array.isArray(image) && image.assetId === assetId ? { ...image, deleted: true } : image) } }))}
        />
      ) : view === "chat" && latestConversationArtifact && latestConversationArtifact.kind !== "视频" && latestConversationArtifact.kind !== "参考图片选择" ? (
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
