import type { AiMode } from "../../../shared/ai";
import type { AiWorkspaceDocument, AiWorkspaceMessage } from "../../../shared/aiWorkspace";

export interface ToolPlanClientContext {
  conversationId?: string;
  projectId?: string;
  projectContext?: string;
  projectDocuments: AiWorkspaceDocument[];
  currentAttachments: AiWorkspaceDocument[];
  messages: Array<Pick<AiWorkspaceMessage, "id" | "role" | "content" | "attachments">>;
  draft: string;
  composerTool: "text" | "presentation" | "image";
  mode: AiMode;
  enabledSkillIds: string[];
}

/** Exact client-side identity for every input that can influence an image/PPT plan. */
export function toolPlanClientContextKey(context: ToolPlanClientContext): string {
  return JSON.stringify({
    conversationId: context.conversationId ?? null,
    projectId: context.projectId ?? null,
    projectContext: context.projectContext ?? "",
    projectDocuments: context.projectDocuments,
    currentAttachments: context.currentAttachments,
    messages: context.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments ?? [],
    })),
    draft: context.draft,
    composerTool: context.composerTool,
    mode: context.mode,
    enabledSkillIds: [...context.enabledSkillIds].sort(),
  });
}

export interface ToolPlanRequestTicket {
  generation: number;
  contextKey: string;
}

/** Prevent a delayed plan response from committing into a changed chat/draft/context. */
export class ToolPlanRequestGate {
  private generation = 0;
  private contextKey = "";

  syncContext(contextKey: string): boolean {
    if (this.contextKey === contextKey) return false;
    this.contextKey = contextKey;
    this.generation += 1;
    return true;
  }

  start(contextKey: string): ToolPlanRequestTicket {
    this.syncContext(contextKey);
    this.generation += 1;
    return { generation: this.generation, contextKey };
  }

  isCurrent(ticket: ToolPlanRequestTicket, currentContextKey: string): boolean {
    return ticket.generation === this.generation
      && ticket.contextKey === this.contextKey
      && ticket.contextKey === currentContextKey;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
