import type { AiChatResponse, AiCitation, AiHarnessTrace, AiMode, AiSource, AiUsage } from "./ai";
import type { AiReplyProcess } from "./aiReplyProcess";
import type { VideoModelId, VideoResolution } from "./aiVideoModels";

/** JSON-only workspace payload. Provider credentials and executable code never belong here. */
export type AiWorkspaceJson = null | boolean | number | string | AiWorkspaceJson[] | { [key: string]: AiWorkspaceJson };

/** Only bounded, locally compressed visual frames; never original video, audio or file paths. */
export interface AiWorkspaceMedia {
  kind: "image" | "video";
  frames: Array<{ dataUrl: string; timeSeconds?: number }>;
  durationSeconds?: number;
  /** Explicit choice among retained video samples; original provenance stays intact. */
  selectedFrameIndex?: number;
}

export interface AiWorkspaceDocument {
  id: string;
  name: string;
  mimeType: string;
  content: string;
  createdAt?: string;
  media?: AiWorkspaceMedia;
}

export interface AiWorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Concise model-authored public explanation, separate from the answer. */
  analysisSummary?: string;
  completion?: AiChatResponse["completion"];
  retryDisposition?: "recover" | "regenerate";
  taskPhase?: "queued" | "planning" | "awaiting_input" | "awaiting_authorization" | "running" | "partial" | "completed" | "failed" | "cancelled" | "unknown";
  time: string;
  /** Epoch milliseconds for a durable in-flight timer. UI remounts must not restart it. */
  startedAt?: number;
  status?: "thinking" | "typing" | "ready" | "error" | "stopped";
  artifactId?: string;
  requestId?: string;
  /** Parent approved tool-plan request, distinct from the execution request. */
  harnessPlanRequestId?: string;
  model?: string;
  usage?: AiUsage;
  attachments?: AiWorkspaceDocument[];
  sources?: AiSource[];
  /** Provider citation markers bound to this exact `content` and `sources`. */
  citations?: AiCitation[];
  /** Concise application-owned rationale and tool lifecycle; never private chain-of-thought. */
  trace?: AiHarnessTrace;
  /** Bounded record of the reply's real process (search calls, public-summary
   * order, durations). Assistant messages only; never answer text or raw reasoning. */
  process?: AiReplyProcess;
}

export interface AiWorkspaceConversation {
  id: string;
  title: string;
  timeLabel: string;
  projectId?: string;
  messages: AiWorkspaceMessage[];
}

export interface AiWorkspaceProject {
  id: string;
  title: string;
  timeLabel: string;
  instructions?: string;
  contextDocuments?: AiWorkspaceDocument[];
}

export interface AiWorkspaceArtifact {
  id: string;
  conversationId: string;
  projectId?: string;
  title: string;
  kind: string;
  updatedLabel: string;
  summary: string;
  sections: Array<{ heading: string; lines: string[] }>;
  data?: { [key: string]: AiWorkspaceJson };
}

/** Draft preferences only; never an executable plan or a permission grant. */
export interface AiWorkspaceVideoDraftSettings {
  model?: VideoModelId;
  seconds: number;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16" | "1:1";
}

export interface AiWorkspaceState {
  view: "chat" | "project" | "skills";
  mode: AiMode;
  conversations: AiWorkspaceConversation[];
  projects: AiWorkspaceProject[];
  artifacts: AiWorkspaceArtifact[];
  drafts: Record<string, string>;
  draftAttachments?: Record<string, AiWorkspaceDocument[]>;
  videoDraftSettings?: Record<string, AiWorkspaceVideoDraftSettings>;
  composerTool?: "text" | "presentation" | "image";
  webSearch?: boolean;
  activeConversationId: string | null;
  activeProjectId: string | null;
  enabledSkillIds: string[];
  sidebarCollapsed?: boolean;
}

/** Informational size of the stored V1 whole-account snapshot (UTF-8 bytes of its JSON). */
export interface AiWorkspaceStorageUsage {
  usedBytes: number;
  limitBytes: number;
}

export interface AiWorkspaceSnapshot {
  revision: number;
  schemaVersion: 1;
  updatedAt: string | null;
  state: AiWorkspaceState | null;
  /** Optional: older servers omit it. Clients must not require it and never compare it for acknowledgement. */
  storage?: AiWorkspaceStorageUsage;
  /** Optional additive fields this server validates. Older servers omit it;
   * a client must not send an optional field whose feature is absent. */
  features?: string[];
}

/** Server features a V1 client checks before persisting the matching optional field. */
export const AI_WORKSPACE_FEATURES = Object.freeze({ replyProcess: "reply-process-v1" });

export interface AiWorkspaceSaveRequest {
  expectedRevision: number;
  mutationId: string;
  state: AiWorkspaceState;
}

/** Rejections never truncate a snapshot or silently remove older conversations. */
export const AI_WORKSPACE_LIMITS = {
  // Snapshots are persisted as bounded SQL chunks. Keep a finite account quota,
  // but do not make a healthy new conversation fail just because earlier chats
  // and generated-media context have crossed the former 2 MiB transport cap.
  stateBytes: 8 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024 + 4096,
  projects: 100,
  conversations: 500,
  messagesPerConversation: 500,
  totalMessages: 5000,
  messageCharacters: 128000,
  artifacts: 500,
  documentsPerContainer: 20,
  documentCharacters: 100000,
  draftCharacters: 24000,
  titleCharacters: 200,
  instructionsCharacters: 24000,
  /**
   * A plan-execute run can contain the initial strategy/route/plan/model
   * steps, three code-owned workflow steps, and up to eight bounded
   * model/tool/approval/result cycles. Keep a small forward-compatible
   * margin while retaining a hard workspace boundary.
   */
  harnessStepsPerTrace: 48,
} as const;
