import { FolderKanban, MessageSquare, MessageSquarePlus, Pencil, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiChatPreflight, AiChatRequest, AiChatResponse, AiRequestResult, AiStatus } from "../../../shared/ai";
import type { AiPersonaSnapshot } from "../../../shared/aiPersona";
import type { AiWorkspaceArtifact, AiWorkspaceDocument, AiWorkspaceMessage, AiWorkspaceProject } from "../../../shared/aiWorkspace";
import type { AiWorkspaceV2Bootstrap, AiWorkspaceV2DirectoryItem, AiWorkspaceV2MessagePage } from "../../../shared/aiWorkspaceV2";
import type { User } from "../../types";
import { useAuth } from "../../auth/AuthContext";
import { useNotificationToolbar } from "../../components/NotificationToolbarContext";
import { ApiRequestError } from "../../lib/api";
import { readAiChatStream } from "../../lib/aiRunStream";
import { ChatWorkspace } from "./ChatWorkspace";
import { TongpinAINameDialog } from "./TongpinAIWorkspaceDialog";
import { TongpinAIAccountUsage } from "./TongpinAIAccountUsage";
import { ArtifactPreview } from "./ArtifactPreview";
import { documentAttachments, extractAttachment, validateAttachments, workspaceAttachment } from "./attachments";
import { buildChatRequest } from "./chatRequests";
import { mentionedCapabilityRequest } from "./skillMentions";
import { toolAttachmentContext } from "./attachmentContext";
import { generatedMediaForFollowup, generatedMediaForMixedFollowup, readGeneratedMedia } from "./generatedMediaContext";
import { mediaCacheScope } from "./mediaCache";
import { registerAiLeaveGuard } from "./workspaceLeaveGuard";
import { waitForReply } from "./waitForReply";
import { workspaceV2Client } from "./workspaceV2Client";
import { preflightNotice } from "./chatPreflight";
import { appendDraftText, draftAfterSend } from "./composerSteer";
import { useSteerController, type SteerSendResult } from "./steerController";
import type { TongpinAIMode, TongpinAIUsage } from "./types";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, type AiReplyProcessLive } from "../../../shared/aiReplyProcess";
import "./workspace-v2.css";

type Bootstrap = Extract<AiWorkspaceV2Bootstrap, { schemaVersion: 2 }>;
type ConversationCache = {
  messages: AiWorkspaceMessage[];
  revision: number;
  hasMore: boolean;
  nextBefore: string | null;
  draft: string;
  persistedDraft: string;
  draftRevision: number;
  attachments: AiWorkspaceDocument[];
  attachmentRevision: number;
  project: AiWorkspaceProject | null;
};
const emptyQuota = { limitTokens: 0, usedTokens: 0, reservedTokens: 0, remainingTokens: 0, inputTokens: 0, outputTokens: 0 };
const timeLabel = () => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
function rememberedSelection(directory: AiWorkspaceV2DirectoryItem[]): string | null {
  return directory[0]?.entityId ?? null;
}
function mergeLatest(current: AiWorkspaceMessage[] | undefined, page: AiWorkspaceV2MessagePage): AiWorkspaceMessage[] {
  if (!current?.length) return page.messages;
  const oldIds = new Set(current.map(message => message.id));
  const overlap = page.messages.find(message => oldIds.has(message.id));
  if (!overlap) return page.messages;
  const prefix = current.slice(0, current.findIndex(message => message.id === overlap.id));
  return [...prefix, ...page.messages];
}
async function replayUncertain<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof ApiRequestError) || error.code !== "NETWORK_UNAVAILABLE") throw error;
    return operation(); // Identical mutationId and body: a lost receipt cannot become a second write.
  }
}
function queryCanRecover(error: unknown): boolean {
  return error instanceof ApiRequestError && ["NETWORK_UNAVAILABLE", "AI_WAIT_TIMEOUT", "AI_REQUEST_IN_PROGRESS", "AI_STREAM_INTERRUPTED"].includes(error.code);
}

/** Activated V2 accounts never mount V1 persistence. This is deliberately a
 * narrow chat slice; generated-media writers stay unavailable until they have
 * a server-owned V2 artifact transaction. */
export function TongpinAIWorkspaceV2({ user, initial, status, persona }: {
  user: User; initial: Bootstrap; status: AiStatus; persona: AiPersonaSnapshot;
}) {
  const { api, session } = useAuth();
  const notificationToolbar = useNotificationToolbar();
  const client = useMemo(() => workspaceV2Client(api, user.id), [api, user.id]);
  const [bootstrap, setBootstrap] = useState(initial);
  const bootstrapRef = useRef(initial);
  const [activeId, setActiveId] = useState(() => rememberedSelection(initial.conversations));
  const [cache, setCache] = useState<Record<string, ConversationCache>>({});
  const cacheRef = useRef<Record<string, ConversationCache>>({});
  const [artifacts, setArtifacts] = useState<Record<string, AiWorkspaceArtifact>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const busyRef = useRef(new Set<string>());
  const [streamContent, setStreamContent] = useState<Record<string, { content: string; analysisSummary: string; startedAt: number; liveProcess?: AiReplyProcessLive }>>({});
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [notice, setNotice] = useState("");
  const [recoveryAction, setRecoveryAction] = useState<{ conversationId: string; requestId: string } | null>(null);
  const [nameDialog, setNameDialog] = useState<{ kind: "new" | "rename"; conversationId?: string; projectId?: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<TongpinAIMode>(initial.manifest.base.mode);
  const [aiStatus, setAiStatus] = useState(status);
  const [focusRequest, setFocusRequest] = useState(0);
  const mountedRef = useRef(true);
  const controllersRef = useRef(new Set<AbortController>());
  const activeControllersRef = useRef(new Map<string, AbortController>());
  const draftTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftSavesRef = useRef(new Map<string, Promise<boolean>>());
  const loadingPromisesRef = useRef(new Map<string, Promise<AiWorkspaceV2MessagePage>>());
  const recoveredRef = useRef(new Set<string>());
  const uncertainAppendsRef = useRef(new Set<string>());
  const active = activeId ? cache[activeId] : undefined;
  const directoryItem = bootstrap.conversations.find(item => item.entityId === activeId);
  const usage: TongpinAIUsage = { periodLabel: "累计使用", ...(aiStatus.quota ?? emptyQuota) };

  const putCache = useCallback((id: string, update: (old: ConversationCache | undefined) => ConversationCache) => {
    const next = { ...cacheRef.current, [id]: update(cacheRef.current[id]) };
    cacheRef.current = next;
    if (mountedRef.current) setCache(next);
  }, []);
  const refreshDirectory = useCallback(async () => {
    const value = await client.bootstrap();
    if (value.schemaVersion !== 2 || value.epoch !== bootstrapRef.current.epoch) throw new Error("工作台版本已变化，请重新打开同频 AI");
    bootstrapRef.current = value;
    if (mountedRef.current) setBootstrap(value);
    return value;
  }, [client]);
  const refreshStatus = useCallback(async () => {
    const value = await api<AiStatus>("/api/ai/status", { headers: { "X-Tongpin-Account": user.id } });
    if (mountedRef.current) setAiStatus(value);
  }, [api, user.id]);

  const fetchArtifacts = useCallback(async (id: string, messages: AiWorkspaceMessage[]) => {
    const refs = [...new Set(messages.flatMap(message => message.artifactId ? [message.artifactId] : []))];
    const results = await Promise.allSettled(refs.map(async ref => ({ ref, artifact: await client.readArtifact(ref, id) })));
    const found = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (found.length && mountedRef.current) setArtifacts(old => ({ ...old, ...Object.fromEntries(found.map(item => [item.ref, item.artifact])) }));
    if (results.some(result => result.status === "rejected") && mountedRef.current) setNotice("部分历史成果暂时无法读取，请刷新当前对话重试。");
  }, [client]);

  const refreshConversation = useCallback(async (id: string) => {
    // Wait for a concurrent page load, then fetch again. A reply committed
    // during that first load must not be hidden until the next page visit.
    const prior = loadingPromisesRef.current.get(id);
    if (prior) await prior.catch(() => undefined);
    if (mountedRef.current && activeId === id) setLoading(true);
    const task = (async () => {
      const [context, page] = await Promise.all([client.context(id), client.messages(id)]);
      if (context.epoch !== bootstrapRef.current.epoch || page.epoch !== context.epoch) throw new Error("对话版本已变化，请重新打开");
      putCache(id, old => {
        if (old && old.revision > page.revision) return old;
        const remoteDraft = context.draft && !context.draft.deleted ? context.draft.value : "";
        const draftDirty = old && old.draft !== old.persistedDraft;
        return {
          messages: mergeLatest(old?.messages, page), revision: page.revision,
          hasMore: page.hasMore || Boolean(old?.hasMore && old.messages.length > page.messages.length),
          nextBefore: old?.hasMore && old.messages.length > page.messages.length ? old.nextBefore : page.nextBefore,
          draft: draftDirty ? old.draft : remoteDraft,
          persistedDraft: remoteDraft, draftRevision: context.draft?.revision ?? 0,
          attachments: context.draftAttachment && !context.draftAttachment.deleted ? context.draftAttachment.value : [],
          attachmentRevision: context.draftAttachment?.revision ?? 0,
          project: context.project && !context.project.deleted ? context.project.value : null,
        };
      });
      void fetchArtifacts(id, page.messages);
      return page;
    })();
    loadingPromisesRef.current.set(id, task);
    try {
      return await task;
    } finally {
      if (loadingPromisesRef.current.get(id) === task) loadingPromisesRef.current.delete(id);
      if (mountedRef.current && activeId === id) setLoading(false);
    }
  }, [activeId, client, fetchArtifacts, putCache]);

  const persistDraft = useCallback(async (id: string): Promise<boolean> => {
    const old = cacheRef.current[id];
    if (!old || old.draft === old.persistedDraft) return true;
    const value = old.draft;
    const mutationId = crypto.randomUUID();
    try {
      const ack = await replayUncertain(() => client.saveDraft(bootstrapRef.current.epoch, id, old.draftRevision, value, mutationId));
      const revision = ack.entities.find(item => item.kind === "draft" && item.entityId === id)?.revision;
      if (!revision) throw new Error("草稿未确认保存");
      putCache(id, current => ({ ...current!, draftRevision: revision, persistedDraft: value }));
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError && ["NETWORK_UNAVAILABLE", "AI_WORKSPACE_CONFLICT"].includes(error.code)) {
        try {
          const remote = (await client.context(id)).draft;
          if (remote && !remote.deleted && remote.value === value) {
            putCache(id, current => ({ ...current!, draftRevision: remote.revision, persistedDraft: value }));
            return true;
          }
          if ((remote?.revision ?? 0) !== old.draftRevision) {
            if (mountedRef.current) setNotice("草稿在其他窗口有修改；当前输入已保留，请先核对后再发送。");
            return false;
          }
        } catch { /* Keep the local draft and let the user retry. */ }
      }
      if (mountedRef.current) setNotice(`草稿未保存：${error instanceof Error ? error.message : "请重试"}`);
      return false;
    }
  }, [client, putCache]);
  const flushDraft = useCallback(async (id: string): Promise<boolean> => {
    const timer = draftTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    draftTimersRef.current.delete(id);
    const prior = draftSavesRef.current.get(id);
    if (prior) await prior;
    const next = persistDraft(id);
    draftSavesRef.current.set(id, next);
    const saved = await next;
    if (draftSavesRef.current.get(id) === next) draftSavesRef.current.delete(id);
    return saved;
  }, [persistDraft]);
  const changeDraft = useCallback((value: string) => {
    // Typing stays enabled while a reply runs: it never touches the running request.
    if (!activeId) return;
    putCache(activeId, old => ({ ...old!, draft: value }));
    const prior = draftTimersRef.current.get(activeId);
    if (prior) clearTimeout(prior);
    draftTimersRef.current.set(activeId, setTimeout(() => { void flushDraft(activeId); }, 350));
  }, [activeId, flushDraft, putCache]);

  const commitRecordedReply = useCallback(async (conversationId: string, requestId: string) => {
    const messageId = `assistant-${requestId}`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const page = await client.messages(conversationId);
      if (page.messages.some(message => message.role === "assistant" && message.requestId === requestId)) {
        await refreshConversation(conversationId);
        return;
      }
      try {
        await client.commitAssistant(bootstrapRef.current.epoch, conversationId, page.revision, requestId, messageId);
        await refreshConversation(conversationId);
        await refreshDirectory();
        return;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || !["AI_WORKSPACE_CONFLICT", "AI_REQUEST_NOT_COMPLETE", "NETWORK_UNAVAILABLE"].includes(error.code) || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }, [client, refreshConversation, refreshDirectory]);

  const recoverRequest = useCallback(async (conversationId: string, requestId: string, manual = false) => {
    if ((!manual && recoveredRef.current.has(requestId)) || busyRef.current.has(conversationId)) return;
    recoveredRef.current.add(requestId);
    busyRef.current.add(conversationId);
    if (mountedRef.current) setBusy(old => ({ ...old, [conversationId]: true }));
    const controller = new AbortController();
    controllersRef.current.add(controller);
    activeControllersRef.current.set(conversationId, controller);
    try {
      await waitForReply(signal => api<AiRequestResult>(`/api/ai/requests/${encodeURIComponent(requestId)}`, {
        headers: { "X-Tongpin-Account": user.id }, signal,
      }, 15_000), controller.signal);
      await commitRecordedReply(conversationId, requestId);
      if (mountedRef.current) setRecoveryAction(null);
      if (mountedRef.current) await refreshStatus();
    } catch (error) {
      if (mountedRef.current && !(error instanceof DOMException && error.name === "AbortError")) {
        setRecoveryAction(queryCanRecover(error) ? { conversationId, requestId } : null);
        setNotice(error instanceof ApiRequestError && error.code === "AI_REQUEST_NOT_FOUND"
          ? "用户消息已保存，但没有查到已提交的模型请求；本次未扣费。可继续发送新消息。"
          : `原请求尚未恢复：${error instanceof Error ? error.message : "请稍后重试"}。不会自动重复扣费。`);
      }
    } finally {
      controllersRef.current.delete(controller);
      if (activeControllersRef.current.get(conversationId) === controller) activeControllersRef.current.delete(conversationId);
      busyRef.current.delete(conversationId);
      if (mountedRef.current) setBusy(old => ({ ...old, [conversationId]: false }));
    }
  }, [api, commitRecordedReply, refreshStatus, user.id]);

  useEffect(() => {
    mountedRef.current = true;
    const unregister = registerAiLeaveGuard(user.id, async () => {
      const ids = Object.keys(cacheRef.current).filter(id => cacheRef.current[id].draft !== cacheRef.current[id].persistedDraft);
      return (await Promise.all(ids.map(flushDraft))).every(Boolean);
    });
    return () => {
      mountedRef.current = false;
      unregister();
      for (const timer of draftTimersRef.current.values()) clearTimeout(timer);
      for (const controller of controllersRef.current) controller.abort();
    };
  }, [flushDraft, user.id]);
  useEffect(() => {
    if (!activeId) return;
    void refreshConversation(activeId).catch(error => setNotice(error instanceof Error ? error.message : "对话暂时无法读取"));
  }, [activeId, refreshConversation]);
  useEffect(() => {
    if (!activeId || !active) return;
    const pending = [...active.messages].reverse().find(message => message.role === "user" && message.requestId &&
      !active.messages.some(reply => reply.role === "assistant" && reply.requestId === message.requestId));
    if (pending?.requestId) void recoverRequest(activeId, pending.requestId);
  }, [active, activeId, recoverRequest]);

  const createConversation = useCallback(async (title: string, projectId?: string) => {
    const id = `conversation-${crypto.randomUUID()}`;
    const mutationId = crypto.randomUUID();
    try {
      await replayUncertain(() => client.mutate(bootstrapRef.current.epoch, [{ kind: "conversation", entityId: id, expectedRevision: 0,
        action: "put", value: { id, title, timeLabel: "刚刚", ...(projectId ? { projectId } : {}), messages: [] } }], mutationId));
      await refreshDirectory();
      setActiveId(id); setNameDialog(null); setFocusRequest(value => value + 1); setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "新建对话失败"); }
  }, [client, refreshDirectory]);
  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const page = await client.messages(id);
      const mutationId = crypto.randomUUID();
      await replayUncertain(() => client.rename(bootstrapRef.current.epoch, id, page.revision, title, mutationId));
      await refreshDirectory();
      setNameDialog(null); setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "重命名失败"); }
  }, [client, refreshDirectory]);
  const selectConversation = useCallback(async (id: string) => {
    if (activeId && !busyRef.current.has(activeId) && !(await flushDraft(activeId))) return;
    setActiveId(id); setPreviewId(null); setNotice("");
  }, [activeId, flushDraft]);
  const loadEarlier = useCallback(async () => {
    if (!activeId || !active?.hasMore || !active.nextBefore) return;
    setLoadingEarlier(true);
    try {
      const page = await client.messages(activeId, active.nextBefore);
      putCache(activeId, old => ({ ...old!, messages: [...page.messages.filter(message => !old!.messages.some(existing => existing.id === message.id)), ...old!.messages],
        hasMore: page.hasMore, nextBefore: page.nextBefore, revision: Math.max(old!.revision, page.revision) }));
      void fetchArtifacts(activeId, page.messages);
    } catch (error) { setNotice(error instanceof Error ? error.message : "较早消息读取失败"); }
    finally { setLoadingEarlier(false); }
  }, [active, activeId, client, fetchArtifacts, putCache]);

  const ensureAttachmentIndex = useCallback(async () => {
    const current = bootstrapRef.current;
    if (current.manifest.hasDraftAttachments) return;
    const mutationId = crypto.randomUUID();
    await replayUncertain(() => client.mutate(current.epoch, [{ kind: "manifest", entityId: "root", expectedRevision: current.manifestRevision,
      action: "put", value: { ...current.manifest, hasDraftAttachments: true } }], mutationId));
    await refreshDirectory();
  }, [client, refreshDirectory]);
  const saveAttachments = useCallback(async (id: string, documents: AiWorkspaceDocument[]) => {
    await ensureAttachmentIndex();
    const current = cacheRef.current[id];
    if (!current) throw new Error("对话尚未加载");
    const mutationId = crypto.randomUUID();
    let ack;
    try { ack = await replayUncertain(() => client.saveDraftAttachments(bootstrapRef.current.epoch, id, current.attachmentRevision, documents, mutationId)); }
    catch (error) {
      if (error instanceof ApiRequestError && ["NETWORK_UNAVAILABLE", "AI_WORKSPACE_CONFLICT"].includes(error.code)) {
        const remote = (await client.context(id)).draftAttachment;
        if (remote && !remote.deleted && JSON.stringify(remote.value) === JSON.stringify(documents)) {
          putCache(id, old => ({ ...old!, attachments: documents, attachmentRevision: remote.revision }));
          return;
        }
      }
      throw error;
    }
    const revision = ack.entities.find(item => item.kind === "draftAttachment" && item.entityId === id)?.revision;
    if (!revision) throw new Error("附件未确认保存");
    putCache(id, old => ({ ...old!, attachments: documents, attachmentRevision: revision }));
  }, [client, ensureAttachmentIndex, putCache]);
  const addFiles = useCallback(async (files: File[], signal?: AbortSignal) => {
    if (!activeId) return;
    try {
      const extracted = await Promise.all(files.map(file => extractAttachment(file, { signal })));
      const current = cacheRef.current[activeId];
      const documents = [...(current?.attachments ?? []), ...extracted.map(file => ({ id: `document-${crypto.randomUUID()}`,
        name: file.name, mimeType: file.mediaType, content: file.text, ...(file.media ? { media: file.media } : {}) }))];
      validateAttachments(documents.map(workspaceAttachment));
      await saveAttachments(activeId, documents);
      setNotice("");
    } catch (error) { setNotice(error instanceof Error ? error.message : "附件添加失败"); }
  }, [activeId, saveAttachments]);

  /** `supplement`: a steer follow-up for `conversationId`; it never consumes the
   * draft or its attachments, and `settle` reports once the user turn is saved. */
  const send = useCallback(async (supplement?: { conversationId: string; text: string; settle: (result: SteerSendResult) => void }) => {
    const id = supplement?.conversationId ?? activeId;
    let settled = false;
    const settle = (result: SteerSendResult) => { if (!settled) { settled = true; supplement?.settle(result); } };
    if (!id || !cacheRef.current[id] || busyRef.current.has(id) || !aiStatus.configured || aiStatus.quota.remainingTokens <= 0) {
      settle(id && busyRef.current.has(id) ? { status: "retry" } : { status: "failed", reason: "AI 服务或额度暂不可用，补充内容已放回输入框" }); return;
    }
    if (uncertainAppendsRef.current.has(id)) { setNotice("上次发送结果尚未核对。请重新打开这段对话后继续，避免重复提交。"); settle({ status: "failed", reason: "上次发送结果尚未核对，补充内容已放回输入框" }); return; }
    busyRef.current.add(id);
    setBusy(old => ({ ...old, [id]: true })); setNotice("");
    const controller = new AbortController();
    controllersRef.current.add(controller);
    activeControllersRef.current.set(id, controller);
    let pendingRequestId: string | null = null;
    let userMessageSaved = false;
    try {
      if (!supplement && !(await flushDraft(id))) return;
      const current = cacheRef.current[id];
      const documents = supplement ? [] : current.attachments;
      const content = supplement ? supplement.text : current.draft.trim() || (documents.length ? "请分析附件内容。" : "");
      if (!content) return;
      // Resolve @Skill / @Hub before the turn is saved so an invalid choice
      // fails with the draft intact instead of leaving an unanswered message.
      const capabilityRequest = mentionedCapabilityRequest(content);
      const requestId = crypto.randomUUID();
      pendingRequestId = requestId;
      const message: AiWorkspaceMessage = { id: `user-${crypto.randomUUID()}`, role: "user", content,
        time: timeLabel(), requestId, ...(documents.length ? { attachments: documents } : {}) };
      const requestAttachments = toolAttachmentContext(documents, current.project?.contextDocuments ?? [], current.messages);
      const hasVisual = requestAttachments.some(item => item.dataUrl);
      if (hasVisual && !aiStatus.visionEnabled) throw new Error("当前模型未开启图片理解，请管理员启用后再发送；草稿已保留。");
      const mediaRefs = /视频|短片|成片|图片|图像|画面|观看|好看|评价|点评|配色|构图|镜头|这张|这段|刚才生成|上面生成|生成结果|生成成果|\bvideo\b|\bimage\b/i.test(content);
      const visibleArtifacts = { ...artifacts };
      if (mediaRefs) {
        const missing = [...new Set(current.messages.flatMap(item => item.artifactId && !visibleArtifacts[item.artifactId] ? [item.artifactId] : []))];
        const found = await Promise.all(missing.map(async ref => ({ ref, artifact: await client.readArtifact(ref, id) })));
        for (const item of found) visibleArtifacts[item.ref] = item.artifact;
        if (found.length && mountedRef.current) setArtifacts(old => ({ ...old, ...Object.fromEntries(found.map(item => [item.ref, item.artifact])) }));
      }
      const media = documents.some(item => item.media)
        ? generatedMediaForMixedFollowup({ id, title: "", timeLabel: "", messages: current.messages }, Object.values(visibleArtifacts), content)
        : generatedMediaForFollowup({ id, title: "", timeLabel: "", messages: current.messages }, Object.values(visibleArtifacts), content);
      const visual = media ? await (async () => {
        if (!aiStatus.visionEnabled) throw new Error("当前模型未开启视觉理解，暂不能讨论生成画面；草稿已保留。");
        const { extractMediaAttachment } = await import("./mediaAttachments");
        return readGeneratedMedia(media, api, user.id, mediaCacheScope(session), controller.signal, extractMediaAttachment);
      })() : undefined;
      const attachments = visual ? toolAttachmentContext(documents, current.project?.contextDocuments ?? [], current.messages, visual) : requestAttachments;
      const appendId = crypto.randomUUID();
      let ack;
      try { ack = await client.appendUser(bootstrapRef.current.epoch, id, cacheRef.current[id].revision, message, appendId); }
      catch (error) {
        if (!(error instanceof ApiRequestError) || error.code !== "NETWORK_UNAVAILABLE") throw error;
        try { ack = await client.appendUser(bootstrapRef.current.epoch, id, cacheRef.current[id].revision, message, appendId); }
        catch (retryError) {
          if (!(retryError instanceof ApiRequestError) || retryError.code !== "NETWORK_UNAVAILABLE") throw retryError;
          try {
            const page = await client.messages(id);
            if (!page.messages.some(item => item.id === message.id && item.requestId === requestId)) throw retryError;
            ack = { epoch: page.epoch, entityId: id, revision: page.revision, messageIds: [message.id] };
          } catch {
            uncertainAppendsRef.current.add(id);
            throw new Error("发送状态未确认，已暂停当前对话的再次发送。重新打开后会先读取原消息，避免重复提交。", { cause: retryError });
          }
        }
      }
      putCache(id, old => ({ ...old!, messages: [...old!.messages, message], revision: ack.revision, draft: supplement ? old!.draft : draftAfterSend(old!.draft, current.draft) }));
      userMessageSaved = true;
      settle({ status: "sent" });
      // Draft cleanup is not a prerequisite for the already accepted model
      // request. A failed cleanup is surfaced, never mistaken for failed send.
      if (!supplement) void flushDraft(id);
      const request: AiChatRequest = { ...buildChatRequest(requestId, mode, [...current.messages, message]),
        conversationId: id, attachments, outputFormat: "text",
        ...(capabilityRequest.skillIds.length ? capabilityRequest : {}),
        ...(current.project?.instructions ? { projectContext: current.project.instructions } : {}),
        ...(mode === "quick" && aiStatus.quickAgent ? { webSearchMode: "auto" as const } : {}),
        ...(supplement ? { supplement: true as const } : {}) };
      const startedAt = Date.now();
      setStreamContent(old => ({ ...old, [id]: { content: "", analysisSummary: "", startedAt } }));
      let result: AiChatResponse;
      try {
        result = await readAiChatStream(api, request, { accountId: user.id, signal: controller.signal, onEvent: event => {
          if (!mountedRef.current) return;
          if (event.type !== "answer_delta" && event.type !== "public_summary_delta") {
            // Ordered process parts from real events only; raw provider reasoning is ignored.
            setStreamContent(old => {
              const current = old[id];
              if (!current) return old;
              const previous = current.liveProcess ?? EMPTY_REPLY_PROCESS_LIVE;
              const liveProcess = applyReplyProcessEvent(previous, event);
              return liveProcess === previous ? old : { ...old, [id]: { ...current, liveProcess } };
            });
            return;
          }
          const delta = event.data.delta;
          setStreamContent(old => {
            const liveProcess = event.type === "public_summary_delta" ? applyReplyProcessEvent(old[id]?.liveProcess ?? EMPTY_REPLY_PROCESS_LIVE, event) : old[id]?.liveProcess;
            return { ...old, [id]: { ...old[id], content: (old[id]?.content ?? "") + (event.type === "answer_delta" ? delta : ""),
              analysisSummary: (old[id]?.analysisSummary ?? "") + (event.type === "public_summary_delta" ? delta : ""), startedAt,
              ...(liveProcess ? { liveProcess } : {}) } };
          });
        } });
      } catch (error) {
        if (!(error instanceof ApiRequestError) || !["NETWORK_UNAVAILABLE", "AI_STREAM_INTERRUPTED", "AI_REQUEST_IN_PROGRESS"].includes(error.code)) throw error;
        result = await waitForReply(signal => api<AiRequestResult>(`/api/ai/requests/${encodeURIComponent(requestId)}`, {
          headers: { "X-Tongpin-Account": user.id }, signal,
        }, 15_000), controller.signal) as AiChatResponse;
      }
      if (result.requestId !== requestId) throw new Error("AI 请求标识与回复不一致");
      await commitRecordedReply(id, requestId);
      if (documents.length) await saveAttachments(id, []).catch(error => {
        if (mountedRef.current) setNotice(`回复已保存，但附件草稿未清理：${error instanceof Error ? error.message : "请刷新后重试"}`);
      });
      await refreshStatus();
    } catch (error) {
      if (mountedRef.current) {
        if (userMessageSaved && pendingRequestId && queryCanRecover(error)) setRecoveryAction({ conversationId: id, requestId: pendingRequestId });
        setNotice(error instanceof Error ? error.message : "对话未完成。已保存的用户消息不会重复提交扣费。");
      }
      settle({ status: "failed", reason: error instanceof Error ? error.message : "补充暂时无法发送，已放回输入框" });
    } finally {
      settle({ status: "failed", reason: "补充暂时无法发送，已放回输入框" });
      controllersRef.current.delete(controller);
      if (activeControllersRef.current.get(id) === controller) activeControllersRef.current.delete(id);
      busyRef.current.delete(id);
      if (mountedRef.current) {
        setBusy(old => ({ ...old, [id]: false }));
        setStreamContent(old => { const next = { ...old }; delete next[id]; return next; });
      }
    }
  }, [activeId, aiStatus.configured, aiStatus.quota.remainingTokens, aiStatus.quickAgent, aiStatus.visionEnabled, api, artifacts, client, commitRecordedReply, flushDraft, mode, putCache, refreshStatus, saveAttachments, session, user.id]);

  // Steer: text-only V2 replies are single-stream, so supplements always wait
  // for the reply to end and go out as one follow-up turn (steerController.ts).
  const sendSupplement = useCallback(async (conversationId: string, text: string): Promise<SteerSendResult> => {
    if (!aiStatus.configured) return { status: "failed", reason: "AI 服务暂不可用，补充内容已放回输入框" };
    if (aiStatus.quota.remainingTokens <= 0) return { status: "failed", reason: "AI 额度不足，补充内容已放回输入框" };
    if (busyRef.current.has(conversationId)) return { status: "retry" };
    const current = cacheRef.current[conversationId];
    if (!current) return { status: "failed", reason: "对话尚未加载，补充内容已放回输入框" };
    try {
      const probe: AiChatRequest = { ...buildChatRequest(crypto.randomUUID(), mode, [...current.messages, { id: "steer-probe", role: "user", content: text, time: timeLabel() }]),
        conversationId, outputFormat: "text", supplement: true };
      const preflight = await api<AiChatPreflight>("/api/ai/preflight", { method: "POST", headers: { "X-Tongpin-Account": user.id }, body: JSON.stringify(probe) });
      if (!preflight.canSend) return { status: preflight.reason === "request_in_progress" ? "retry" : "failed", reason: preflightNotice(preflight).message };
    } catch (error) { return { status: "failed", reason: error instanceof Error ? error.message : "额度暂时无法核对，补充内容已放回输入框" }; }
    if (!mountedRef.current) return { status: "failed", reason: "页面已关闭，补充未发送" };
    return new Promise<SteerSendResult>(resolve => { void send({ conversationId, text, settle: resolve }); });
  }, [aiStatus.configured, aiStatus.quota.remainingTokens, api, mode, send, user.id]);
  const steer = useSteerController({
    sendFollowUp: sendSupplement,
    restoreDraft: (conversationId, text, reason) => {
      if (!cacheRef.current[conversationId]) { setNotice(`${reason}：${text}`); return; }
      putCache(conversationId, old => ({ ...old!, draft: appendDraftText(old!.draft, text) }));
      void flushDraft(conversationId);
      setNotice(reason);
    },
    recordDelivered: () => undefined,
    isResponding: conversationId => busyRef.current.has(conversationId),
    isRunActive: () => false,
    notify: setNotice,
  });
  useEffect(() => { steer.sync(); }, [steer, busy]);

  const displayMessages: Array<AiWorkspaceMessage & { liveProcess?: AiReplyProcessLive }> = active ? [...active.messages] : [];
  if (activeId && busy[activeId] && streamContent[activeId]) displayMessages.push({
    id: `stream-${activeId}`, role: "assistant", content: streamContent[activeId].content,
    analysisSummary: streamContent[activeId].analysisSummary || undefined,
    time: timeLabel(), status: streamContent[activeId].content ? "typing" : "thinking", startedAt: streamContent[activeId].startedAt,
    ...(streamContent[activeId].liveProcess ? { liveProcess: streamContent[activeId].liveProcess } : {}),
  });
  const activeArtifacts = new Map(Object.entries(artifacts).filter(([, item]) => item.conversationId === activeId));
  const preview = previewId ? activeArtifacts.get(previewId) : undefined;
  const activeProjectTitle = bootstrap.projects.find(project => project.entityId === directoryItem?.projectId)?.title;
  return <section className={`tp-ai-page tp-ai-v2${collapsed ? " is-sidebar-collapsed" : ""}${preview ? " has-preview" : ""}`} aria-label="同频 AI 工作台">
    <aside className={`tp-ai-sidebar tp-ai-v2-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="对话列表">
      <header className="tp-ai-sidebar__brand"><span className="tp-ai-sidebar__mark">AI</span>{!collapsed && <span className="tp-ai-sidebar__brand-name"><strong>同频 AI</strong><small>我的对话</small></span>}
        <button type="button" className="tp-ai-sidebar__toggle" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button></header>
      <div className="tp-ai-sidebar__primary-actions"><button type="button" className="is-primary" onClick={() => setNameDialog({ kind: "new" })}><MessageSquarePlus size={17} />{!collapsed && "新对话"}</button></div>
      {!collapsed && <nav className="tp-ai-v2-list" aria-label="项目与对话">
        {bootstrap.projects.map(project => <div key={project.entityId} className="tp-ai-v2-project"><div className="tp-ai-v2-project-title"><FolderKanban size={15} />{project.title}<button type="button" aria-label={`在${project.title}中新建对话`} onClick={() => setNameDialog({ kind: "new", projectId: project.entityId })}><MessageSquarePlus size={15} /></button></div>
          {bootstrap.conversations.filter(item => item.projectId === project.entityId).map(item => <button key={item.entityId} type="button" className={item.entityId === activeId ? "is-active" : ""} onClick={() => void selectConversation(item.entityId)}><MessageSquare size={14} /><span>{item.title}</span>{busy[item.entityId] && <i aria-label="回复中">•</i>}</button>)}</div>)}
        <div className="tp-ai-v2-project-title">普通对话</div>
        {bootstrap.conversations.filter(item => !item.projectId).map(item => <div key={item.entityId} className="tp-ai-v2-conversation"><button type="button" className={item.entityId === activeId ? "is-active" : ""} onClick={() => void selectConversation(item.entityId)}><MessageSquare size={14} /><span>{item.title}</span>{busy[item.entityId] && <i aria-label="回复中">•</i>}</button><button type="button" aria-label={`重命名${item.title}`} onClick={() => setNameDialog({ kind: "rename", conversationId: item.entityId })}><Pencil size={14} /></button></div>)}
      </nav>}
      {!collapsed && <TongpinAIAccountUsage user={user} usage={usage} quotaSynced onRefresh={refreshStatus} />}
    </aside>
    {activeId ? <ChatWorkspace key={activeId} viewerId={user.id} textOnly assistantName={persona.profile.name || "同频 AI"} characterExpression={persona.profile.expression}
      artifactById={activeArtifacts} composerFocusRequest={focusRequest} conversationId={activeId} conversationTitle={directoryItem?.title}
      projectId={directoryItem?.projectId} projectTitle={activeProjectTitle} projectContext={active?.project?.instructions}
      projectDocuments={active?.project?.contextDocuments} draft={active?.draft ?? ""} attachments={active?.attachments ?? []}
      onAddFiles={addFiles} onRemoveAttachment={index => { if (active) void saveAttachments(activeId, active.attachments.filter((_, i) => i !== index)).catch(error => setNotice(error instanceof Error ? error.message : "附件移除失败")); }}
      onSelectVideoFrame={(attachmentIndex, frameIndex) => {
        if (!active) return;
        const selected = active.attachments[attachmentIndex];
        if (selected?.media?.kind !== "video" || !selected.media.frames[frameIndex]) return;
        void saveAttachments(activeId, active.attachments.map((document, index) => index === attachmentIndex && document.media?.kind === "video"
          ? { ...document, media: { ...document.media, selectedFrameIndex: frameIndex } } : document)).catch(error => setNotice(error instanceof Error ? error.message : "采样画面未保存"));
      }}
      visionEnabled={aiStatus.visionEnabled === true}
      enabledSkills={[]} messages={displayMessages} hasMoreMessages={active?.hasMore} loadingEarlierMessages={loadingEarlier} onLoadEarlierMessages={() => void loadEarlier()}
      mode={mode} notificationUnread={notificationToolbar?.unread ?? 0} quotaInsufficient={aiStatus.quota.remainingTokens <= 0}
      responding={Boolean(busy[activeId])} connectionLoading={loading} serviceConnected={aiStatus.configured}
      sidebarCollapsed={collapsed} onToggleSidebar={() => setCollapsed(value => !value)} onDraftChange={changeDraft} onModeChange={setMode}
      onOpenNotifications={notificationToolbar?.openNotificationDrawer} onOpenArtifact={id => {
        if (artifacts[id]) { setPreviewId(id); return; }
        void client.readArtifact(id, activeId).then(artifact => { setArtifacts(old => ({ ...old, [id]: artifact })); setPreviewId(id); })
          .catch(error => setNotice(error instanceof Error ? error.message : "成果读取失败"));
      }} onSubmit={() => void send()}
      pendingSupplements={steer.bubbles(activeId)} onCancelSupplement={id => steer.cancel(id)}
      onSteer={text => { const added = steer.add(activeId, text, { kind: "followup" }); if (!added.ok) setNotice(added.reason); return added.ok; }}
      onStop={() => { activeControllersRef.current.get(activeId)?.abort(); setNotice("已停止等待；原请求可在重新打开对话后按原编号查询，不会重新提交。"); }}
      onRefreshConnection={() => void refreshStatus()} /> : <main className="tp-ai-v2-empty"><h1>开始一段新对话</h1><button type="button" onClick={() => setNameDialog({ kind: "new" })}>新建对话</button></main>}
    {preview && <ArtifactPreview artifact={preview} onClose={() => setPreviewId(null)} />}
    {notice && <div className="tp-ai-v2-notice" role="alert"><span>{notice}</span>{recoveryAction && <button type="button" onClick={() => void recoverRequest(recoveryAction.conversationId, recoveryAction.requestId, true)}>查询原请求</button>}<button type="button" onClick={() => { setNotice(""); setRecoveryAction(null); }}>关闭</button></div>}
    {nameDialog && <TongpinAINameDialog kind="conversation" title={nameDialog.kind === "new" ? "新建对话" : "重命名对话"}
      label="对话名称" description="" confirmLabel={nameDialog.kind === "new" ? "新建对话" : "保存名称"}
      initialValue={nameDialog.kind === "rename" ? bootstrap.conversations.find(item => item.entityId === nameDialog.conversationId)?.title : ""}
      unavailableNames={bootstrap.conversations.filter(item => item.entityId !== nameDialog.conversationId).map(item => item.title)}
      onCancel={() => setNameDialog(null)} onConfirm={title => nameDialog.kind === "new" ? void createConversation(title, nameDialog.projectId) : nameDialog.conversationId && void renameConversation(nameDialog.conversationId, title)} />}
  </section>;
}
