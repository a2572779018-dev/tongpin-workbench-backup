import {
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronDown,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  PanelLeft,
  Paperclip,
  Plus,
  Presentation,
  SlidersHorizontal,
  Settings2,
  Sparkles,
  Square,
  X,
  Zap,
  Video,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import autoAnimate from "@formkit/auto-animate";
import type {
  TongpinAIArtifact,
  TongpinAIDemoAction,
  TongpinAIMode,
  TongpinAIMessage,
  TongpinAISkill,
} from "./types";
import { TongpinAINotificationButton } from "./TongpinAINotificationButton";
import { TongpinAICharacter } from "./visuals/TongpinAICharacter";
import type { AiPersonaExpression } from "../../../shared/aiPersona";
import type { AiHarnessTrace, AiToolPlan } from "../../../shared/ai";
import { didCharacterReplyComplete, type CharacterActivity, type CharacterReplySnapshot } from "./visuals/characterExpression";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { ATTACHMENT_ACCEPT, TEXT_ATTACHMENT_ACCEPT, workspaceAttachment } from "./attachments";
import { AI_IMAGE_ACCEPT, AI_VIDEO_ACCEPT } from "../../../shared/aiMedia";
import { AttachmentChips } from "./AttachmentChips";
import { ChatMessageRow } from "./ChatMessageRow";
import { AiVideoComposer, type VideoComposerHandle } from "./AiVideoComposer";
import { ComputerUsePanel } from "./ComputerUsePanel";
import type { ComputerUseModelPlan } from "./computerUseFlow";
import type { ComputerUseWindowState } from "../../../shared/computerUse";
import type { VideoChatRequest } from "./videoChat";
import { CHAT_MESSAGE_PAGE_SIZE } from "./chatPerformance";
import { TONGPIN_AI_SKILLS } from "./mockData";
import { activeSkillMention, insertSkillMention, mentionedToolIds, resolveToolIntent, TOOL_MENTIONS, WORKFLOW_MENTIONS } from "./skillMentions";
import { ToolPlanRequestGate, toolPlanClientContextKey } from "./toolPlanState";
import { videoReferencesFromAttachments, type LocalVideoReferenceImage } from "./videoReferenceAttachments";
import "./skill-mentions.css";

const EMPTY_PROJECT_DOCUMENTS: AiWorkspaceDocument[] = [];

interface ChatWorkspaceProps {
  artifactById: Map<string, TongpinAIArtifact>;
  composerFocusRequest: number;
  conversationId?: string;
  conversationTitle?: string;
  draft: string;
  enabledSkills: TongpinAISkill[];
  messages: TongpinAIMessage[];
  mode: TongpinAIMode;
  notificationUnread: number;
  projectId?: string;
  projectTitle?: string;
  projectContext?: string;
  projectDocuments?: AiWorkspaceDocument[];
  quotaInsufficient: boolean;
  checkingQuota?: boolean;
  budgetNotice?: { title: string; message: string; canDisableSearch: boolean };
  onDisableSearch?: () => void;
  responding: boolean;
  responsePhase?: "waiting" | "typing";
  connectionLoading?: boolean;
  availabilityBlocked?: boolean;
  availabilityNotice?: ReactNode;
  connectionError?: string;
  onRefreshConnection?: () => void;
  onRetry?: (messageId: string) => void;
  onTraceChange?: (messageId: string, trace: AiHarnessTrace) => void;
  retryableMessageIds?: Set<string>;
  sidebarCollapsed?: boolean;
  serviceConnected?: boolean;
  onDraftChange: (draft: string) => void;
  onDemoAction?: (action: TongpinAIDemoAction) => void;
  attachments?: AiWorkspaceDocument[];
  onAddFiles?: (files: File[], signal?: AbortSignal) => void | Promise<void>;
  onRemoveAttachment?: (index: number) => void;
  composerTool?: "text" | "presentation" | "image";
  onComposerToolChange?: (tool: "text" | "presentation" | "image") => void;
  imageEnabled?: boolean;
  visionEnabled?: boolean;
  webSearchEnabled?: boolean;
  quickAuto?: boolean;
  webSearch?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  assistantName?: string;
  characterExpression?: AiPersonaExpression;
  characterPaused?: boolean;
  onEditPersona?: () => void;
  onModeChange: (mode: TongpinAIMode) => void;
  onOpenNotifications?: () => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenSkills?: () => void;
  onToggleSidebar?: () => void;
  onStop?: () => void;
  onSubmit: (approvedPlan?: AiToolPlan & { originalPrompt: string }) => void;
  onPlanTool?: (kind: "image" | "video" | "presentation", prompt: string, videoRequest?: VideoChatRequest) => Promise<AiToolPlan>;
  onSubmitVideo?: (request: VideoChatRequest) => Promise<boolean>;
  onUseVideoHistory?: (jobId: string) => Promise<boolean>;
  computerAvailable?: boolean;
  computerRequest?: { id: string; originalPrompt: string };
  onOpenComputer?: (prompt: string) => void;
  onPlanComputer?: (originalPrompt: string, state: ComputerUseWindowState) => Promise<ComputerUseModelPlan>;
  onCloseComputer?: () => void;
  onComputerResult?: (message: string) => void;
}

export function ChatWorkspace({
  artifactById,
  composerFocusRequest,
  conversationId,
  conversationTitle,
  draft,
  enabledSkills,
  messages,
  mode,
  notificationUnread,
  projectId,
  projectTitle,
  projectContext,
  projectDocuments = EMPTY_PROJECT_DOCUMENTS,
  quotaInsufficient,
  checkingQuota = false,
  budgetNotice,
  responding,
  responsePhase = "waiting",
  connectionLoading = false,
  availabilityBlocked = false,
  availabilityNotice,
  connectionError = "",
  onRefreshConnection,
  onRetry,
  onTraceChange,
  retryableMessageIds,
  sidebarCollapsed = false,
  serviceConnected = false,
  onDraftChange,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  composerTool = "text",
  onComposerToolChange,
  imageEnabled = false,
  visionEnabled = false,
  webSearchEnabled = false,
  quickAuto = false,
  webSearch = false,
  onWebSearchChange,
  assistantName = "同频 AI",
  characterExpression = "auto",
  characterPaused = false,
  onEditPersona,
  onModeChange,
  onOpenNotifications,
  onOpenArtifact,
  onOpenSkills,
  onToggleSidebar,
  onStop,
  onSubmit,
  onPlanTool,
  onSubmitVideo,
  onUseVideoHistory,
  computerAvailable = false,
  computerRequest,
  onOpenComputer,
  onPlanComputer,
  onCloseComputer,
  onComputerResult,
}: ChatWorkspaceProps) {
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<ReturnType<typeof activeSkillMention>>();
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionSkills = mention ? [
    ...TONGPIN_AI_SKILLS.map(({ id, name }) => ({ id, name, available: true })),
    ...WORKFLOW_MENTIONS.map(({ id, name }) => ({ id, name: `${name} · 工作流`, available: true })),
    ...TOOL_MENTIONS.map(tool => ({
      ...tool,
      available: tool.id !== "computer" || computerAvailable,
    })),
  ].filter(s => `${s.id} ${s.name}`.toLowerCase().includes(mention.query)) : [];
  function trackMention(value: string, caret: number) { setMention(activeSkillMention(value, caret)); setMentionIndex(0); }
  function chooseMention(id: string) {
    if (!mention || videoBusy || (id === "computer" && !computerAvailable)) return;
    const next = insertSkillMention(draft, mention, id);
    onDraftChange(next.text); setMention(undefined);
    requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.setSelectionRange(next.caret, next.caret); });
  }
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const followResponseRef = useRef(true);
  const [menu, setMenu] = useState<"attachments" | "tools" | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoInitial, setVideoInitial] = useState<VideoChatRequest | undefined>();
  const [videoAttachmentReferences, setVideoAttachmentReferences] = useState<LocalVideoReferenceImage[]>([]);
  const [videoBusy, setVideoBusy] = useState(false);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const controller = autoAnimate(list, { duration: 160, easing: "ease-out" });
    return () => controller.disable();
  }, []);
  const [imagePlan, setImagePlan] = useState<(AiToolPlan & { originalPrompt: string }) | null>(null);
  const [presentationPlan, setPresentationPlan] = useState<(AiToolPlan & { originalPrompt: string }) | null>(null);
  const [imagePlanning, setImagePlanning] = useState(false);
  const [queuedToolPlan, setQueuedToolPlan] = useState<{
    kind: "image" | "presentation";
    originalPrompt: string;
    contextKey: string;
  } | null>(null);
  const toolPlanGateRef = useRef(new ToolPlanRequestGate());
  const videoComposerRef = useRef<VideoComposerHandle>(null);
  const enabledSkillPlanKey = enabledSkills.map(skill => skill.id).sort().join("\u0000");
  const toolPlanContextKeyFor = useCallback((tool: "text" | "presentation" | "image") => toolPlanClientContextKey({
      conversationId,
      projectId,
      projectContext,
      projectDocuments,
      currentAttachments: attachments,
      messages,
      draft,
      composerTool: tool,
      mode,
      enabledSkillIds: enabledSkillPlanKey ? enabledSkillPlanKey.split("\u0000") : [],
    }),
    [attachments, conversationId, draft, enabledSkillPlanKey, messages, mode, projectContext, projectDocuments, projectId],
  );
  const toolPlanContextKey = useMemo(() => toolPlanContextKeyFor(composerTool), [composerTool, toolPlanContextKeyFor]);
  const latestToolPlanContextKeyRef = useRef(toolPlanContextKey);
  latestToolPlanContextKeyRef.current = toolPlanContextKey;
  toolPlanGateRef.current.syncContext(toolPlanContextKey);
  useEffect(() => {
    setVideoOpen(false);
    setVideoBusy(false);
    setVideoInitial(undefined);
    setVideoAttachmentReferences([]);
  }, [conversationId]);
  useEffect(() => {
    setImagePlan(null);
    setPresentationPlan(null);
    setImagePlanning(false);
  }, [toolPlanContextKey]);
  useEffect(() => () => toolPlanGateRef.current.invalidate(), []);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const attachmentController = useRef<AbortController | null>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);
  const isEmpty = messages.length === 0;
  const [readingFiles, setReadingFiles] = useState(false);
  const [fileError, setFileError] = useState("");
  const [celebrating, setCelebrating] = useState(false);
  const previousReply = useRef<CharacterReplySnapshot>({});
  const fileReadingRef = useRef(false);
  useEffect(() => () => attachmentController.current?.abort(), [conversationId]);
  const [historyWindow, setHistoryWindow] = useState({ conversationId, count: CHAT_MESSAGE_PAGE_SIZE });
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const callbacksRef = useRef({ onOpenArtifact, onRetry, onRefreshConnection });
  callbacksRef.current = { onOpenArtifact, onRetry, onRefreshConnection };
  const videoComposerContextRef = useRef({ attachments, onComposerToolChange, onDraftChange, onWebSearchChange });
  videoComposerContextRef.current = { attachments, onComposerToolChange, onDraftChange, onWebSearchChange };
  const videoSettled = useCallback(() => callbacksRef.current.onRefreshConnection?.(), []);
  const openArtifact = useCallback((id: string) => callbacksRef.current.onOpenArtifact(id), []);
  const retryMessage = useCallback((id: string) => callbacksRef.current.onRetry?.(id), []);
  const visibleCount = historyWindow.conversationId === conversationId ? historyWindow.count : CHAT_MESSAGE_PAGE_SIZE;
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const capabilityUnavailable = composerTool === "image" ? !imageEnabled : webSearch && !webSearchEnabled;
  const computerMentioned = mentionedToolIds(draft).includes("computer");
  const openVideoComposer = useCallback((initial?: VideoChatRequest) => {
    const { attachments: currentAttachments, onComposerToolChange: changeComposerTool, onWebSearchChange: changeWebSearch } = videoComposerContextRef.current;
    const migration = videoReferencesFromAttachments(currentAttachments);
    if (!migration.ok) {
      setFileError(migration.message);
      return false;
    }
    setFileError("");
    setVideoInitial(initial);
    setVideoAttachmentReferences(initial?.referenceImages ?? migration.images);
    setVideoOpen(true);
    setMenu(null);
    changeComposerTool?.("text");
    changeWebSearch?.(false);
    requestAnimationFrame(() => composerRef.current?.focus());
    return true;
  }, []);
  const editVideo = useCallback((request: VideoChatRequest) => {
    videoComposerContextRef.current.onDraftChange(request.originalPrompt ?? request.prompt);
    openVideoComposer(request);
  }, [openVideoComposer]);
  const beginToolPlan = useCallback((kind: "image" | "presentation", originalPrompt: string, contextKey: string) => {
    if (!onPlanTool) {
      setFileError("同频 AI 任务规划暂不可用，请稍后重试");
      return;
    }
    const ticket = toolPlanGateRef.current.start(contextKey);
    setImagePlanning(true);
    setFileError("");
    void onPlanTool(kind, originalPrompt).then(plan => {
      if (!toolPlanGateRef.current.isCurrent(ticket, latestToolPlanContextKeyRef.current)) return;
      if (plan.kind !== kind) throw new Error(`同频 AI 返回的不是${kind === "image" ? "图片" : "PPT"}任务，请重新整理`);
      const confirmed = { ...plan, originalPrompt };
      if (kind === "image") setImagePlan(confirmed);
      else setPresentationPlan(confirmed);
    }).catch(error => {
      if (toolPlanGateRef.current.isCurrent(ticket, latestToolPlanContextKeyRef.current)) setFileError(error instanceof Error ? error.message : `同频 AI 暂时无法整理${kind === "image" ? "图片" : "PPT"}任务`);
    }).finally(() => {
      if (toolPlanGateRef.current.isCurrent(ticket, latestToolPlanContextKeyRef.current)) setImagePlanning(false);
    });
  }, [onPlanTool]);
  useEffect(() => {
    if (!queuedToolPlan) return;
    const targetTool = queuedToolPlan.kind === "image" ? "image" : "presentation";
    if (toolPlanContextKeyFor(targetTool) !== queuedToolPlan.contextKey) {
      setQueuedToolPlan(null);
      return;
    }
    if (composerTool !== targetTool) return;
    setQueuedToolPlan(null);
    if (
      !queuedToolPlan.originalPrompt || responding || checkingQuota || readingFiles || fileReadingRef.current
      || quotaInsufficient || !serviceConnected || connectionError || connectionLoading || availabilityBlocked
      || (queuedToolPlan.kind === "image" && (!imageEnabled || attachments.length > 0))
    ) return;
    beginToolPlan(queuedToolPlan.kind, queuedToolPlan.originalPrompt, queuedToolPlan.contextKey);
  }, [
    attachments.length,
    availabilityBlocked,
    beginToolPlan,
    checkingQuota,
    composerTool,
    connectionError,
    connectionLoading,
    imageEnabled,
    queuedToolPlan,
    quotaInsufficient,
    readingFiles,
    responding,
    serviceConnected,
    toolPlanContextKey,
    toolPlanContextKeyFor,
  ]);
  useEffect(() => {
    if (quickAuto && mode === "quick" && webSearch) onWebSearchChange?.(false);
  }, [quickAuto, mode, webSearch, onWebSearchChange]);
  const lastMessage = messages.at(-1);
  const responseFailed = lastMessage?.role === "assistant" && lastMessage.status === "error";
  const currentReplyPending = lastMessage?.role === "assistant" && (lastMessage.status === "thinking" || lastMessage.status === "typing");
  const characterActivity: CharacterActivity = currentReplyPending
    ? lastMessage.status === "typing" ? "typing" : "waiting"
    : responseFailed ? "error" : celebrating ? "completed" : "idle";

  useEffect(() => {
    const current: CharacterReplySnapshot = { conversationId, messageId: lastMessage?.id, role: lastMessage?.role, status: lastMessage?.status };
    const completed = didCharacterReplyComplete(previousReply.current, current);
    previousReply.current = current;
    setCelebrating(false);
    if (!completed) return;
    setCelebrating(true);
    const timer = window.setTimeout(() => setCelebrating(false), 3000);
    return () => window.clearTimeout(timer);
  }, [conversationId, lastMessage?.id, lastMessage?.role, lastMessage?.status]);

  useEffect(() => {
    followResponseRef.current = true;
    setShowScrollDown(false);
    setMenu(null);
    setCopiedId(null);
    setCopyError("");
    historyAnchorRef.current = null;
    const list = messageListRef.current;
    if (list) list.scrollTop = isEmpty ? 0 : list.scrollHeight;
  }, [conversationId, isEmpty]);
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const list = messageListRef.current;
    if (anchor && list) list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
    historyAnchorRef.current = null;
  }, [visibleCount]);
  useEffect(() => {
    const list = messageListRef.current;
    if (list && followResponseRef.current) list.scrollTop = isEmpty ? 0 : list.scrollHeight;
  }, [messages, isEmpty]);
  useEffect(() => {
    // Local typewriter updates do not rerender this workspace. Observe only the
    // active reply's height to retain follow-to-bottom without a polling loop.
    if ((!responding && (!lastMessage?.artifactId || artifactById.get(lastMessage.artifactId)?.kind !== "视频")) || typeof ResizeObserver === "undefined") return;
    const list = messageListRef.current;
    const reply = list?.lastElementChild;
    if (!list || !reply) return;
    const observer = new ResizeObserver(() => {
      if (followResponseRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(reply);
    return () => observer.disconnect();
  }, [responding, responsePhase, conversationId, messages.length, lastMessage?.artifactId, artifactById]);
  useEffect(() => {
    if (composerFocusRequest > 0) composerRef.current?.focus();
  }, [composerFocusRequest]);
  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [draft, conversationId]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (!menu) return;
    (
      menuRef.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? menuRef.current
    )?.focus();
    function closeOnPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !actionTriggerRef.current?.contains(target) &&
        !toolsTriggerRef.current?.contains(target)
      )
        setMenu(null);
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        (menu === "attachments"
          ? actionTriggerRef
          : toolsTriggerRef
        ).current?.focus();
        return;
      }
      if (!menuRef.current?.contains(document.activeElement)) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      );
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    }
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menu]);

  function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const { mentionedTools, requestedTool } = resolveToolIntent(draft);
    if (mentionedTools.length > 1) {
      setFileError("一次只能选择一个 @ 工具，请移除多余工具后重试。");
      return;
    }
    if (mentionedTools[0] === "computer") {
      if (responding || checkingQuota || readingFiles || fileReadingRef.current) return;
      if (attachments.length) {
        setFileError("电脑控制不会读取聊天附件，请先移除附件再开启。");
        return;
      }
      if (!onOpenComputer) {
        setFileError("电脑控制只在已接入安全桌面桥的同频安装版中可用。");
        return;
      }
      setFileError("");
      setMenu(null);
      setVideoOpen(false);
      setVideoInitial(undefined);
      setVideoAttachmentReferences([]);
      setImagePlan(null);
      setPresentationPlan(null);
      onComposerToolChange?.("text");
      onWebSearchChange?.(false);
      onOpenComputer(draft.trim());
      return;
    }
    if (videoOpen) {
      if (!responding && !videoBusy) videoComposerRef.current?.submit(); return;
    }
    if (onSubmitVideo && !responding && requestedTool === "video") {
      openVideoComposer(); return;
    }
    if ((requestedTool === "image" && composerTool !== "image") || (requestedTool === "ppt" && composerTool !== "presentation")) {
      if (responding || checkingQuota || readingFiles || fileReadingRef.current || quotaInsufficient || !serviceConnected || connectionError || connectionLoading || availabilityBlocked) return;
      if (requestedTool === "image" && !imageEnabled) {
        setFileError("图片生成尚未启用，请联系管理员配置。");
        return;
      }
      if (requestedTool === "image" && attachments.length) {
        setFileError("图片生成暂不支持普通附件，请先移除附件再试。");
        return;
      }
      const pendingPlanKind = requestedTool === "image" ? "image" : "presentation";
      const targetComposerTool = pendingPlanKind === "image" ? "image" : "presentation";
      const originalPrompt = draft.trim();
      setQueuedToolPlan({ kind: pendingPlanKind, originalPrompt, contextKey: toolPlanContextKeyFor(targetComposerTool) });
      onComposerToolChange?.(targetComposerTool);
      if (pendingPlanKind === "image") onWebSearchChange?.(false);
      setMenu(null);
      return;
    }
    if ((!draft.trim() && !attachments.length) || responding || checkingQuota || readingFiles || fileReadingRef.current || quotaInsufficient || !serviceConnected || connectionError || connectionLoading || availabilityBlocked || capabilityUnavailable) return;
    const pendingPlanKind = composerTool === "image" ? "image" : composerTool === "presentation" ? "presentation" : undefined;
    const approvedPlan = composerTool === "image" ? imagePlan : composerTool === "presentation" ? presentationPlan : null;
    if (pendingPlanKind && !approvedPlan) {
      if (imagePlanning || !draft.trim()) return;
      if (pendingPlanKind === "image" && attachments.length) {
        setFileError("图片生成暂不支持普通附件，请先移除附件再试。");
        return;
      }
      const originalPrompt = draft.trim();
      beginToolPlan(pendingPlanKind, originalPrompt, toolPlanContextKey);
      return;
    }
    followResponseRef.current = true;
    setMenu(null);
    onSubmit(imagePlan ?? presentationPlan ?? undefined);
  }
  async function addFiles(files: File[]) {
    if (!files.length || !onAddFiles || fileReadingRef.current) return;
    const controller = new AbortController(); attachmentController.current = controller;
    fileReadingRef.current = true; setReadingFiles(true); setFileError("");
    try { await onAddFiles(files, controller.signal); }
    catch (caught) { if (!controller.signal.aborted) setFileError(caught instanceof Error ? caught.message : "附件读取失败，请重试"); }
    finally { if (attachmentController.current === controller) attachmentController.current = null; fileReadingRef.current = false; setReadingFiles(false); }
  }
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (mention) {
      if (event.key === "Escape") { event.preventDefault(); setMention(undefined); return; }
      if (mentionSkills.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Enter" || event.key === "Tab") chooseMention(mentionSkills[mentionIndex % mentionSkills.length].id);
        else setMentionIndex(n => (n + (event.key === "ArrowDown" ? 1 : -1) + mentionSkills.length) % mentionSkills.length);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.repeat) return;
    event.preventDefault();
    submitMessage();
  }
  const copyMessage = useCallback(async (message: TongpinAIMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      setCopyError("");
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopyError("复制失败，请选中文字复制。");
    }
  }, []);

  return (
    <section
      className={`tp-ai-chat${isEmpty ? " is-empty" : ""}`}
      aria-label={`与${assistantName}对话`}
    >
      <header className="tp-ai-chat__header">
        <div className="tp-ai-chat__identity">
          <button
            type="button"
            className={`tp-ai-sidebar-toggle${sidebarCollapsed ? " is-collapsed" : ""}`}
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            onClick={onToggleSidebar}
          >
            <PanelLeft size={19} />
          </button>
          {!isEmpty && <TongpinAICharacter expression={characterExpression} activity={characterActivity}
            paused={characterPaused} className="tp-ai-character--header" />}
          <div className="tp-ai-chat__title">
            <strong>{conversationTitle ?? assistantName}</strong>
            {projectTitle && <small>{projectTitle}</small>}
          </div>
          {(!serviceConnected || connectionError || connectionLoading) && (
            <span className="tp-ai-connection-state">
              {connectionLoading ? "同步中" : connectionError ? "连接异常" : "未配置"}
            </span>
          )}
        </div>
        {onEditPersona ? <button type="button" className="tp-ai-persona-settings-trigger" aria-label="专属 AI 设置" title="专属 AI 设置" onClick={onEditPersona}><Settings2 size={18} /></button> : null}
        <TongpinAINotificationButton
          unread={notificationUnread}
          onClick={onOpenNotifications}
        />
      </header>

      <div
        ref={messageListRef}
        className="tp-ai-messages"
        role="log"
        aria-live={responding ? "off" : "polite"}
        aria-busy={responding}
        aria-relevant="additions text"
        onScroll={() => {
          const list = messageListRef.current;
          if (!list) return;
          const nearBottom =
            list.scrollHeight - list.scrollTop - list.clientHeight < 90;
          followResponseRef.current = nearBottom;
          setShowScrollDown(!nearBottom);
        }}
      >
        {isEmpty ? (
          <div className="tp-ai-chat-welcome">
            <TongpinAICharacter expression={characterExpression} paused={characterPaused} className="tp-ai-character--welcome" />
            <h1>今天，一起完成什么？</h1>
            {projectTitle && <p>{projectTitle}</p>}
            <div className="tp-ai-starters" aria-label="开始一项任务">
              {[
                { title: "整理文档", text: "请帮我整理这份文档，提炼重点、待办和需要确认的问题。" },
                { title: "起草方案", text: "请帮我起草一份工作方案。先和我确认目标、受众与交付要求。" },
                { title: "制作演示大纲", text: "请帮我设计一份演示文稿的大纲。先和我确认主题、受众和预计页数。" },
              ].map(starter => <button key={starter.title} type="button" disabled={responding || quotaInsufficient}
                onClick={() => { onDraftChange(starter.text); composerRef.current?.focus(); }}>{starter.title}</button>)}
            </div>
          </div>
        ) : (
          <>
            {hiddenCount > 0 && <button type="button" className="tp-ai-load-earlier" onClick={() => {
              const list = messageListRef.current;
              if (list) historyAnchorRef.current = { height: list.scrollHeight, top: list.scrollTop };
              followResponseRef.current = false;
              setHistoryWindow({ conversationId, count: visibleCount + CHAT_MESSAGE_PAGE_SIZE });
            }}>加载更早的消息（还有 {hiddenCount} 条）</button>}
            {messages.slice(hiddenCount).map(message => {
              const artifact = message.artifactId ? artifactById.get(message.artifactId) : undefined;
              const isVideoArtifact = artifact?.kind === "视频" && typeof artifact.data?.videoJobId === "string";
              return <ChatMessageRow
                key={message.id} message={message}
                artifact={artifact}
                assistantName={assistantName} copied={copiedId === message.id}
                retryable={Boolean(retryableMessageIds?.has(message.id))}
                retryDisabled={message.status === "error" && responding}
                onCopy={copyMessage} onOpenArtifact={openArtifact} onRetry={retryMessage}
                onTraceChange={onTraceChange}
                onVideoSettled={isVideoArtifact ? videoSettled : undefined}
                videoEditDisabled={isVideoArtifact ? responding || videoBusy || videoOpen || Boolean(draft.trim()) || Boolean(attachments.length) : undefined}
                onEditVideo={isVideoArtifact && onSubmitVideo ? editVideo : undefined}
              />;
            })}
          </>
        )}
      </div>

      <footer className="tp-ai-composer-wrap">
        {!computerRequest && availabilityNotice}
        {fileError ? <p className="tp-ai-copy-error" role="alert">{fileError}</p> : null}
        {!computerRequest && capabilityUnavailable && serviceConnected ? <div className="tp-ai-quota-block" role="status"><span>{composerTool === "image" ? "图片生成尚未启用，请取消图片模式或联系管理员配置。" : "联网搜索当前不可用，请关闭搜索或联系管理员配置。"}</span></div> : null}
        {!computerRequest && (connectionError || (!connectionLoading && !serviceConnected)) && (
          <div className="tp-ai-quota-block" role="status">
            <span>{connectionError || "管理员尚未启用 AI 服务。"}</span>
            <button type="button" onClick={onRefreshConnection}>刷新状态</button>
          </div>
        )}
        {showScrollDown && (
          <button
            type="button"
            className="tp-ai-jump-latest"
            aria-label="回到最新消息"
            onClick={() => {
              followResponseRef.current = true;
              const list = messageListRef.current;
              if (list) list.scrollTop = list.scrollHeight;
              setShowScrollDown(false);
            }}
          >
            <ArrowDown size={17} />
          </button>
        )}
        {!computerRequest && budgetNotice && (
          <div className="tp-ai-quota-block tp-ai-budget-notice" role="alert">
            <span><strong>{budgetNotice.title}</strong><small>{budgetNotice.message}</small></span>
          </div>
        )}
        {!computerRequest && quotaInsufficient && !budgetNotice && (
          <div className="tp-ai-quota-block" role="alert">
            <span>
              <strong>AI 额度不足</strong>
              <small>请联系管理员增加额度。</small>
            </span>
          </div>
        )}
        {copyError && (
          <p className="tp-ai-copy-error" role="status">
            {copyError}
          </p>
        )}
        <div className="tp-ai-beam-wrap">
          {computerRequest && onPlanComputer ? <ComputerUsePanel
            key={computerRequest.id}
            requestId={computerRequest.id}
            originalPrompt={computerRequest.originalPrompt}
            onPlan={onPlanComputer}
            onClose={onCloseComputer ?? (() => undefined)}
            onResult={onComputerResult ?? (() => undefined)}
          /> : computerRequest ? <p className="tp-ai-copy-error" role="alert">电脑动作规划器未接入，已停止流程。</p> : (
          <form className="tp-ai-composer" onSubmit={submitMessage}>
            {videoOpen && onSubmitVideo && onPlanTool ? <AiVideoComposer ref={videoComposerRef} tier={mode} initialRequest={videoInitial} initialReferenceImages={videoAttachmentReferences} prompt={draft} onPlan={request => onPlanTool("video", request.prompt, request)} onSubmit={onSubmitVideo} onUseHistory={onUseVideoHistory} onBusy={setVideoBusy} onClose={() => { setVideoOpen(false); setVideoBusy(false); setVideoInitial(undefined); setVideoAttachmentReferences([]); }} /> : null}
            <input ref={fileInputRef} type="file" aria-label="选择附件文件" accept={visionEnabled ? ATTACHMENT_ACCEPT : TEXT_ATTACHMENT_ACCEPT} multiple hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            <input ref={imageInputRef} type="file" aria-label="选择图片" accept={AI_IMAGE_ACCEPT} multiple hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            <input ref={videoInputRef} type="file" aria-label="选择视频" accept={AI_VIDEO_ACCEPT} hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            <input ref={skillInputRef} type="file" accept=".md,.markdown" hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            {!videoOpen && attachments.length ? <AttachmentChips attachments={attachments.map(workspaceAttachment)} onRemove={index => onRemoveAttachment?.(index)} disabled={responding || readingFiles} /> : null}
            {readingFiles ? <div className="tp-ai-attachment-progress" role="status"><LoaderCircle size={16} />正在处理附件…<button type="button" onClick={() => attachmentController.current?.abort()}>取消</button></div> : null}
            {composerTool !== "text" ? <div className="tp-ai-composer-capabilities" aria-label="当前生成设置">
              <button type="button" disabled={responding} onClick={() => onComposerToolChange?.("text")} aria-label={`取消${composerTool === "presentation" ? "生成 PPT" : "生成图片"}`}>
                {composerTool === "presentation" ? <Presentation size={14} /> : <ImageIcon size={14} />}{composerTool === "presentation" ? "生成 PPT" : "生成图片"}<X size={13} />
              </button>
            </div> : null}
            {composerTool === "image" && imagePlan ? <section className="tp-ai-tool-plan" aria-label="同频 AI 整理的图片任务"><strong>同频 AI 已整理任务</strong><p>{imagePlan.summary}</p><label>生成提示词<textarea value={imagePlan.prompt} readOnly /></label><small>如需修改，请直接改上方任务描述，再让同频 AI 重新整理。</small></section> : composerTool === "presentation" && presentationPlan ? <section className="tp-ai-tool-plan" aria-label="同频 AI 整理的 PPT 任务"><strong>同频 AI 已整理任务</strong><p>{presentationPlan.summary}</p><label>PPT 生成要求<textarea value={presentationPlan.prompt} readOnly /></label><small>如需修改，请直接改上方任务描述，再让同频 AI 重新整理。</small></section> : composerTool === "image" || composerTool === "presentation" ? <p className="tp-ai-tool-plan-hint">先由同频 AI 整理任务，再由你确认生成。</p> : null}
            <label htmlFor="tp-ai-message-input" className="sr-only">
              输入你的任务
            </label>
            <textarea
              ref={composerRef}
              id="tp-ai-message-input"
              value={draft}
              readOnly={videoBusy}
              rows={2}
              placeholder={videoOpen ? "描述你想生成的视频…" : composerTool === "image" ? "描述你想生成的图片…" : composerTool === "presentation" ? "告诉我 PPT 的主题、用途和页数…" : `把任务交给${assistantName}…`}
              aria-controls={mention ? "tp-ai-skill-mentions" : undefined}
              aria-expanded={Boolean(mention)}
              aria-activedescendant={mentionSkills.length ? `tp-ai-mention-${mentionSkills[mentionIndex % mentionSkills.length].id}` : undefined}
              onChange={(event) => { setImagePlan(null); setPresentationPlan(null); onDraftChange(event.target.value); trackMention(event.target.value, event.target.selectionStart); }}
              onClick={event => trackMention(draft, event.currentTarget.selectionStart)}
              onBlur={() => setMention(undefined)}
              onKeyDown={handleComposerKeyDown}
              onPaste={event => {
                const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
                if (!images.length) return;
                event.preventDefault();
                if (videoOpen) { setFileError("请用视频设置中的「添加参考图片」上传参考图"); return; }
                if (composerTool === "image") { setFileError("图片生成模式暂不支持参考图，请切换到对话后添加图片"); return; }
                if (!visionEnabled) { setFileError("请管理员先启用图片理解"); return; }
                if (!responding) void addFiles(images);
              }}
            />
            {computerMentioned ? <p className="tp-ai-computer-input-warning" role="note">请勿在 @computer 请求中填写密码、验证码、API 密钥或其他敏感信息；请求会发送给同频 AI 规划。</p> : null}
            {mention && !videoBusy ? <div className="tp-ai-skill-mentions" id="tp-ai-skill-mentions" role="listbox" aria-label="选择技能">
              {mentionSkills.length ? mentionSkills.map((skill, index) => <button type="button" role="option" id={`tp-ai-mention-${skill.id}`} key={skill.id} disabled={!skill.available} aria-disabled={!skill.available} aria-selected={index === mentionIndex % mentionSkills.length} onMouseDown={e => e.preventDefault()} onClick={() => chooseMention(skill.id)}><span>{skill.name}</span><small>{skill.available ? `@${skill.id}` : "仅桌面端可用"}</small></button>) : <p>没有已接入的匹配技能</p>}
            </div> : null}
            <div className="tp-ai-composer__toolbar" ref={toolbarRef}>
              <div className="tp-ai-composer__actions">
                <button
                  ref={actionTriggerRef}
                  disabled={videoBusy || responding}
                  type="button"
                  className="tp-ai-action-trigger"
                  aria-label="添加附件或生成内容"
                  aria-haspopup="menu"
                  aria-expanded={menu === "attachments"}
                  aria-controls="tp-ai-attachment-menu"
                  onClick={() =>
                    setMenu(menu === "attachments" ? null : "attachments")
                  }
                >
                  <Plus size={20} />
                </button>
                <button
                  ref={toolsTriggerRef}
                  disabled={videoOpen || videoBusy || responding}
                  type="button"
                  className="tp-ai-tools-trigger"
                  aria-label="选择工具"
                  aria-haspopup="menu"
                  aria-expanded={menu === "tools"}
                  aria-controls="tp-ai-tools-menu"
                  onClick={() => setMenu(menu === "tools" ? null : "tools")}
                >
                  <SlidersHorizontal size={16} />
                  <span>工具</span>
                  {enabledSkills.length > 0 && (
                    <small>{enabledSkills.length}</small>
                  )}
                </button>
                {menu && (
                  <div
                    ref={menuRef}
                    id={
                      menu === "attachments"
                        ? "tp-ai-attachment-menu"
                        : "tp-ai-tools-menu"
                    }
                    className="tp-ai-action-menu tp-ai-composer-menu"
                    role="menu"
                    tabIndex={-1}
                    aria-label={
                      menu === "attachments" ? "附件与生成" : "对话工具"
                    }
                    onBlur={(event) => {
                      if (
                        !event.currentTarget.contains(event.relatedTarget) &&
                        event.relatedTarget !== actionTriggerRef.current &&
                        event.relatedTarget !== toolsTriggerRef.current
                      )
                        setMenu(null);
                    }}
                  >
                    {menu === "attachments" ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={responding || readingFiles || composerTool === "image" || !onAddFiles}
                          title={composerTool === "image" ? "图片模式仅支持文字描述" : "提取 TXT、Markdown、CSV、JSON、PDF、DOCX 的文字"}
                          onClick={() => { setMenu(null); fileInputRef.current?.click(); }}
                        >
                          <Paperclip size={18} />
                          <span>上传文件</span>
                        </button>
                        <button type="button" role="menuitem" disabled={responding || readingFiles || composerTool === "image" || !visionEnabled || !onAddFiles}
                          title={!visionEnabled ? "请管理员启用支持视觉输入的模型" : "PNG、JPEG、WebP，单张最大 12 MB"}
                          onClick={() => { setMenu(null); imageInputRef.current?.click(); }}>
                          <ImagePlus size={18} /><span>上传图片</span>
                        </button>
                        <button type="button" role="menuitem" disabled={responding || readingFiles || composerTool === "image" || !visionEnabled || !onAddFiles}
                          title={!visionEnabled ? "请管理员启用支持视觉输入的模型" : "最多 2 分钟 / 50 MB；分析最多 4 个采样画面，不含音频"}
                          onClick={() => { setMenu(null); videoInputRef.current?.click(); }}>
                          <Video size={18} /><span>上传视频</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={responding || readingFiles || composerTool === "image" || !onAddFiles}
                          title="仅将 SKILL.md 作为文本说明，不安装或执行代码"
                          onClick={() => { setMenu(null); skillInputRef.current?.click(); }}
                        >
                          <Sparkles size={18} />
                          <span>导入技能说明</span>
                        </button>
                        <div role="separator" />
                        <button type="button" role="menuitem" disabled={responding || readingFiles || !onSubmitVideo} onClick={() => { openVideoComposer(); }}>
                          <Video size={18} /><span>生成视频</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={responding || readingFiles || !serviceConnected || !onComposerToolChange}
                          onClick={() => {
                            setMenu(null);
                            onComposerToolChange?.("presentation"); composerRef.current?.focus();
                          }}
                        >
                          <Presentation size={18} />
                          <span>生成 PPT</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={responding || readingFiles || !imageEnabled || attachments.length > 0 || !onComposerToolChange}
                          title={!imageEnabled ? "请管理员配置图片生成与折算额度" : attachments.length ? "请先移除附件，图片模式仅支持文字描述" : "生成一张图片"}
                          onClick={() => {
                            setMenu(null);
                            onWebSearchChange?.(false); onComposerToolChange?.("image"); composerRef.current?.focus();
                          }}
                        >
                          <ImageIcon size={18} />
                          <span>生成图片</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            onOpenSkills?.();
                          }}
                        >
                          <Sparkles size={18} />
                          <span>选择 Skill</span>
                          <ChevronDown size={14} />
                        </button>
                        {enabledSkills.length > 0 && (
                          <div className="tp-ai-selected-skills">
                            <small>已选择</small>
                            {enabledSkills.map((skill) => (
                              <span key={skill.id}>{skill.name}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              {videoOpen ? <span className="tp-ai-image-mode-label"><Video size={15} />视频生成</span> : composerTool === "image" ? <span className="tp-ai-image-mode-label"><ImageIcon size={15} />图片生成</span> : <label className="tp-ai-mode-select">
                {mode === "quick" ? <Zap size={15} /> : <Brain size={15} />}
                <select
                  aria-label="思考模式"
                  disabled={responding}
                  value={mode}
                  onChange={(event) =>
                    onModeChange(event.target.value as TongpinAIMode)
                  }
                >
                  <option value="quick">快速模式</option>
                  <option value="standard">标准模式</option>
                  <option value="deep">深度思考</option>
                  <option value="pro">Pro 模式</option>
                </select>
                <ChevronDown size={12} />
              </label>}
              {responding ? (
                <button
                  type="button"
                  className="tp-ai-send-button"
                  aria-label={responsePhase === "typing" ? "立即显示完整回复" : "停止等待回复"}
                  disabled={!onStop}
                  onClick={onStop}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="tp-ai-send-button"
                  disabled={computerMentioned ? responding || readingFiles || !onOpenComputer || attachments.length > 0 : videoOpen ? videoBusy || !draft.trim() : imagePlanning || checkingQuota || readingFiles || quotaInsufficient || (!draft.trim() && !attachments.length) || !serviceConnected || Boolean(connectionError) || connectionLoading || availabilityBlocked || capabilityUnavailable}
                  aria-label={computerMentioned ? "进入安全电脑控制" : videoOpen ? "继续视频生成流程" : imagePlanning ? `同频 AI 正在整理${composerTool === "presentation" ? "PPT" : "图片"}任务` : composerTool === "image" && imagePlan ? "确认生成图片" : composerTool === "presentation" && presentationPlan ? "确认生成 PPT" : composerTool === "image" ? "让同频 AI 整理图片任务" : composerTool === "presentation" ? "让同频 AI 整理 PPT 任务" : checkingQuota ? "正在核对额度" : "发送消息"}
                  aria-busy={checkingQuota || imagePlanning}
                >
                  {checkingQuota || imagePlanning ? <LoaderCircle size={20} /> : <ArrowUp size={20} strokeWidth={2.5} />}
                </button>
              )}
            </div>
          </form>
          )}
        </div>
        <p className="tp-ai-composer-hint">{computerRequest ? "每个动作都需要一次原生确认；关闭即停止本机会话" : "Enter 发送 · Shift + Enter 换行"}</p>
      </footer>
    </section>
  );
}
