import {
  ArrowDown,
  ArrowUp,
  Brain,
  ChevronDown,
  Globe,
  Image as ImageIcon,
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
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  TongpinAIArtifact,
  TongpinAIDemoAction,
  TongpinAIMode,
  TongpinAIMessage,
  TongpinAISkill,
} from "./types";
import { TongpinAINotificationButton } from "./TongpinAINotificationButton";
import { TongpinOrb } from "./visuals/TongpinOrb";
import { TongpinMetalIdentity } from "./visuals/TongpinMetalIdentity";
import { BorderBeam } from "./visuals/vendor/border-beam/src";
import { useAmbientMotion } from "./visuals/useAmbientMotion";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { ATTACHMENT_ACCEPT } from "./attachments";
import { AttachmentChips } from "./AttachmentChips";
import { ChatMessageRow } from "./ChatMessageRow";
import { CHAT_MESSAGE_PAGE_SIZE } from "./chatPerformance";

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
  projectTitle?: string;
  quotaInsufficient: boolean;
  responding: boolean;
  responsePhase?: "waiting" | "typing";
  connectionLoading?: boolean;
  connectionError?: string;
  onRefreshConnection?: () => void;
  onRetry?: (messageId: string) => void;
  retryableMessageIds?: Set<string>;
  sidebarCollapsed?: boolean;
  serviceConnected?: boolean;
  onDraftChange: (draft: string) => void;
  onDemoAction?: (action: TongpinAIDemoAction) => void;
  attachments?: AiWorkspaceDocument[];
  onAddFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (index: number) => void;
  composerTool?: "text" | "presentation" | "image";
  onComposerToolChange?: (tool: "text" | "presentation" | "image") => void;
  imageEnabled?: boolean;
  webSearchEnabled?: boolean;
  webSearch?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  assistantName?: string;
  onEditPersona?: () => void;
  onModeChange: (mode: TongpinAIMode) => void;
  onOpenNotifications?: () => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenSkills?: () => void;
  onToggleSidebar?: () => void;
  onStop?: () => void;
  onSubmit: () => void;
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
  projectTitle,
  quotaInsufficient,
  responding,
  responsePhase = "waiting",
  connectionLoading = false,
  connectionError = "",
  onRefreshConnection,
  onRetry,
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
  webSearchEnabled = false,
  webSearch = false,
  onWebSearchChange,
  assistantName = "同频 AI",
  onEditPersona,
  onModeChange,
  onOpenNotifications,
  onOpenArtifact,
  onOpenSkills,
  onToggleSidebar,
  onStop,
  onSubmit,
}: ChatWorkspaceProps) {
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const followResponseRef = useRef(true);
  const [menu, setMenu] = useState<"attachments" | "tools" | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);
  const isEmpty = messages.length === 0;
  const ambientMotion = useAmbientMotion();
  const [composerFocused, setComposerFocused] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [fileError, setFileError] = useState("");
  const [visualEffects, setVisualEffects] = useState(false);
  const fileReadingRef = useRef(false);
  const [historyWindow, setHistoryWindow] = useState({ conversationId, count: CHAT_MESSAGE_PAGE_SIZE });
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const callbacksRef = useRef({ onOpenArtifact, onRetry });
  callbacksRef.current = { onOpenArtifact, onRetry };
  const openArtifact = useCallback((id: string) => callbacksRef.current.onOpenArtifact(id), []);
  const retryMessage = useCallback((id: string) => callbacksRef.current.onRetry?.(id), []);
  const visibleCount = historyWindow.conversationId === conversationId ? historyWindow.count : CHAT_MESSAGE_PAGE_SIZE;
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const capabilityUnavailable = composerTool === "image" ? !imageEnabled : webSearch && !webSearchEnabled;

  useEffect(() => {
    followResponseRef.current = true;
    setShowScrollDown(false);
    setMenu(null);
    setCopiedId(null);
    setCopyError("");
    historyAnchorRef.current = null;
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [conversationId]);
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    const list = messageListRef.current;
    if (anchor && list) list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
    historyAnchorRef.current = null;
  }, [visibleCount]);
  useEffect(() => {
    const list = messageListRef.current;
    if (list && followResponseRef.current) list.scrollTop = list.scrollHeight;
  }, [messages]);
  useEffect(() => {
    // Local typewriter updates do not rerender this workspace. Observe only the
    // active reply's height to retain follow-to-bottom without a polling loop.
    if (!responding || typeof ResizeObserver === "undefined") return;
    const list = messageListRef.current;
    const reply = list?.lastElementChild;
    if (!list || !reply) return;
    const observer = new ResizeObserver(() => {
      if (followResponseRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(reply);
    return () => observer.disconnect();
  }, [responding, responsePhase, conversationId, messages.length]);
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
    if (!draft.trim() || responding || readingFiles || fileReadingRef.current || quotaInsufficient || !serviceConnected || connectionError || connectionLoading || capabilityUnavailable) return;
    followResponseRef.current = true;
    setMenu(null);
    onSubmit();
  }
  async function addFiles(files: File[]) {
    if (!files.length || !onAddFiles || fileReadingRef.current) return;
    fileReadingRef.current = true; setReadingFiles(true); setFileError("");
    try { await onAddFiles(files); }
    catch (caught) { setFileError(caught instanceof Error ? caught.message : "附件读取失败，请重试"); }
    finally { fileReadingRef.current = false; setReadingFiles(false); }
  }
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key !== "Enter" || event.shiftKey) return;
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
          <TongpinOrb
            active={responding}
            richMotion={visualEffects}
            size={40}
            className="tp-ai-composer-orb"
          />
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
        <button type="button" className="tp-ai-motion-toggle" aria-label="视觉动效" aria-pressed={visualEffects}
          title={visualEffects ? "关闭视觉动效，降低 GPU 占用" : "开启视觉动效会增加 GPU 负担；性能较低的电脑建议保持关闭"}
          onClick={() => setVisualEffects(current => !current)}><Sparkles size={16} /><span>动效{visualEffects ? "开" : "关"}</span></button>
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
            <TongpinMetalIdentity richMotion={visualEffects} />
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
            {messages.slice(hiddenCount).map(message => <ChatMessageRow
              key={message.id} message={message}
              artifact={message.artifactId ? artifactById.get(message.artifactId) : undefined}
              assistantName={assistantName} copied={copiedId === message.id}
              retryable={Boolean(retryableMessageIds?.has(message.id))}
              retryDisabled={message.status === "error" && responding}
              onCopy={copyMessage} onOpenArtifact={openArtifact} onRetry={retryMessage}
            />)}
          </>
        )}
      </div>

      <footer className="tp-ai-composer-wrap">
        {readingFiles ? <p className="tp-ai-copy-error" role="status">正在读取附件，请稍候…</p> : null}
        {fileError ? <p className="tp-ai-copy-error" role="alert">{fileError}</p> : null}
        {capabilityUnavailable && serviceConnected ? <div className="tp-ai-quota-block" role="status"><span>{composerTool === "image" ? "图片生成尚未启用，请取消图片模式或联系管理员配置。" : "联网搜索当前不可用，请关闭搜索或联系管理员配置。"}</span></div> : null}
        {(connectionError || (!connectionLoading && !serviceConnected)) && (
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
        {quotaInsufficient && (
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
        <BorderBeam
          className="tp-ai-beam-wrap"
          theme="light"
          colorVariant="mono"
          strength={0.28}
          glowSize={0.3}
          duration={5}
          borderRadius={16}
          staticColors
          active={visualEffects && ambientMotion && (composerFocused || responding)}
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setComposerFocused(false);
          }}
        >
          <form className="tp-ai-composer" onSubmit={submitMessage}>
            <input ref={fileInputRef} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            <input ref={skillInputRef} type="file" accept=".md,.markdown" hidden onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
              if (files.length) void addFiles(files);
            }} />
            {attachments.length ? <AttachmentChips attachments={attachments.map(file => ({ name: file.name, text: file.content, mediaType: file.mimeType }))} onRemove={index => onRemoveAttachment?.(index)} disabled={responding || readingFiles} /> : null}
            {composerTool !== "text" || webSearch ? <div className="tp-ai-composer-capabilities" aria-label="当前生成设置">
              {composerTool !== "text" ? <button type="button" disabled={responding} onClick={() => onComposerToolChange?.("text")} aria-label={`取消${composerTool === "presentation" ? "生成 PPT" : "生成图片"}`}>
                {composerTool === "presentation" ? <Presentation size={14} /> : <ImageIcon size={14} />}{composerTool === "presentation" ? "生成 PPT" : "生成图片"}<X size={13} />
              </button> : null}
              {webSearch && composerTool !== "image" ? <button type="button" disabled={responding} onClick={() => onWebSearchChange?.(false)} aria-label="关闭联网搜索"><Globe size={14} />联网搜索<X size={13} /></button> : null}
            </div> : null}
            <label htmlFor="tp-ai-message-input" className="sr-only">
              输入你的任务
            </label>
            <textarea
              ref={composerRef}
              id="tp-ai-message-input"
              value={draft}
              rows={2}
              placeholder={composerTool === "image" ? "描述你想生成的图片…" : composerTool === "presentation" ? "告诉我 PPT 的主题、用途和页数…" : `把任务交给${assistantName}…`}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="tp-ai-composer__toolbar" ref={toolbarRef}>
              <div className="tp-ai-composer__actions">
                <button
                  ref={actionTriggerRef}
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
                          <small>文档资料</small>
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
                          <small>SKILL.md</small>
                        </button>
                        <div role="separator" />
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
                          <small>可编辑 PPTX</small>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={responding || readingFiles || !imageEnabled || attachments.length > 0 || !onComposerToolChange}
                          title={!imageEnabled ? "请管理员配置图片模型与折算额度" : attachments.length ? "请先移除附件，图片模式仅支持文字描述" : "生成一张图片"}
                          onClick={() => {
                            setMenu(null);
                            onWebSearchChange?.(false); onComposerToolChange?.("image"); composerRef.current?.focus();
                          }}
                        >
                          <ImageIcon size={18} />
                          <span>生成图片</span>
                          <small>{imageEnabled ? "文字生成" : "需管理员配置"}</small>
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
                        <button type="button" role="menuitemcheckbox" aria-checked={webSearch} disabled={responding || !webSearchEnabled || composerTool === "image" || !onWebSearchChange}
                          title={!webSearchEnabled ? "请管理员启用联网搜索并设置折算额度" : "使用服务商的联网搜索工具"}
                          onClick={() => { onWebSearchChange?.(!webSearch); setMenu(null); }}>
                          <Globe size={18} />
                          <span>联网搜索</span>
                          <small>{webSearchEnabled ? webSearch ? "已开启" : "未开启" : "需管理员配置"}</small>
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
              <label className="tp-ai-mode-select">
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
                  <option value="deep">深度思考</option>
                </select>
                <ChevronDown size={12} />
              </label>
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
                  disabled={readingFiles || quotaInsufficient || !draft.trim() || !serviceConnected || Boolean(connectionError) || connectionLoading || capabilityUnavailable}
                  aria-label="发送消息"
                >
                  <ArrowUp size={20} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </form>
        </BorderBeam>
        <p className="tp-ai-composer-hint">Enter 发送 · Shift + Enter 换行</p>
      </footer>
    </section>
  );
}
