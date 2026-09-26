import type { AiChatResponse, AiCitation, AiHarnessTrace, AiQuota, AiUsage, AiSource } from "../../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceJson } from "../../../shared/aiWorkspace";
import type { AiReplyProcess, AiReplyProcessLive } from "../../../shared/aiReplyProcess";
import type { TongpinAILiveThinking } from "./liveThinking";

export type AiQuotaFilter = "all" | "available" | "low" | "empty";

export type AiQuotaLedgerKind = "grant" | "usage" | "reset";

export interface AiQuotaMember {
  id: string;
  name: string;
  email: string;
  jobTitle: string;
  monthlyLimit: number;
  bonusQuota: number;
  usedQuota: number;
  lastActiveAt: string;
}

export interface AiQuotaLedgerEntry {
  id: string;
  memberId: string;
  memberName: string;
  kind: AiQuotaLedgerKind;
  delta: number;
  balanceAfter: number;
  reason: string;
  operator: string;
  createdAt: string;
}

// Shared P0 member-workbench contracts. These live beside the quota contracts so
// the independently-built AI surfaces can use one type-only module when composed.
export type TongpinAIMode = "quick" | "standard" | "deep" | "pro";

export type TongpinAIWorkspaceView = "chat" | "project" | "skills";

export type TongpinAIDemoAction = "ppt" | "image";

export interface TongpinAIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  analysisSummary?: string;
  completion?: AiChatResponse["completion"];
  retryDisposition?: "recover" | "regenerate";
  taskPhase?: "queued" | "planning" | "awaiting_input" | "awaiting_authorization" | "running" | "partial" | "completed" | "failed" | "cancelled" | "unknown";
  time: string;
  /** Epoch milliseconds for a durable in-flight timer. */
  startedAt?: number;
  status?: "thinking" | "typing" | "ready" | "error" | "stopped";
  artifactId?: string;
  requestId?: string;
  harnessPlanRequestId?: string;
  model?: string;
  usage?: AiUsage;
  attachments?: AiWorkspaceDocument[];
  sources?: AiSource[];
  /** Provider citation markers bound to this exact `content` and `sources`. */
  citations?: AiCitation[];
  trace?: AiHarnessTrace;
  /** Display-only live reasoning/tool progress for an in-flight reply. Never
   * persisted in the workspace and never included in model context. */
  liveThinking?: TongpinAILiveThinking;
  /** Settled, bounded record of the reply's real process parts. */
  process?: AiReplyProcess;
  /** Display-only ordered process state while the reply streams; never persisted. */
  liveProcess?: AiReplyProcessLive;
}

export interface TongpinAIConversation {
  id: string;
  title: string;
  timeLabel: string;
  projectId?: string;
  messages: TongpinAIMessage[];
}

export interface TongpinAIProject {
  id: string;
  title: string;
  timeLabel: string;
  instructions?: string;
  contextDocuments?: AiWorkspaceDocument[];
}

export interface TongpinAIUsage extends AiQuota {
  periodLabel: string;
}

export interface TongpinAIArtifactSection {
  heading: string;
  lines: string[];
}

export interface TongpinAIArtifact {
  id: string;
  conversationId: string;
  projectId?: string;
  title: string;
  kind: string;
  updatedLabel: string;
  summary: string;
  sections: TongpinAIArtifactSection[];
  data?: { [key: string]: AiWorkspaceJson };
}

export type TongpinAISkillIcon =
  "writing" | "research" | "slides" | "data" | "meeting" | "campaign";

export type TongpinAISkillAccent = "yellow" | "blue" | "pink" | "green";

export interface TongpinAISkill {
  id: string;
  name: string;
  description: string;
  category: "内容" | "研究" | "办公" | "增长";
  icon: TongpinAISkillIcon;
  accent: TongpinAISkillAccent;
  featured?: boolean;
}
