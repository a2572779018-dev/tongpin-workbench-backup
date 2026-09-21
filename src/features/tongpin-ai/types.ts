import type { AiHarnessTrace, AiQuota, AiUsage, AiSource } from "../../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceJson } from "../../../shared/aiWorkspace";

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
  trace?: AiHarnessTrace;
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
