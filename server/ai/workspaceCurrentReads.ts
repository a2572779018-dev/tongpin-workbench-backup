import type { AiWorkspaceConversation } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { tenantStorageKey } from "./tenant";
import { AiWorkspaceRepository, validateAiWorkspaceConversationEntity } from "./workspace";
import { AiWorkspaceV2Store } from "./workspaceV2Store";

export interface AiCurrentConversation {
  conversation: AiWorkspaceConversation;
  revision: number;
  schemaVersion: 1 | 2;
  epoch?: number;
}

/** Read only the current member's requested conversation. V2 deliberately
 * never reconstructs the account snapshot through V1's 8 MiB validator. */
export async function readCurrentConversation(store: AiStore, userId: string, conversationId: string): Promise<AiCurrentConversation | null> {
  store.assertAccess(userId);
  const storedUser = tenantStorageKey(store.tenantId, userId);
  const version = store.sql.all<{ schema_version: number }>(
    "SELECT schema_version FROM ai_workspaces WHERE tenant_id=? AND user_id=?", store.tenantId, storedUser,
  )[0]?.schema_version ?? 1;
  const workspace = new AiWorkspaceRepository(store.sql);
  if (version === 1) {
    const snapshot = workspace.read(userId, store.tenantId);
    const conversation = snapshot.state?.conversations.find(item => item.id === conversationId);
    return conversation ? { conversation, revision: snapshot.revision, schemaVersion: 1 } : null;
  }
  if (version !== 2) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "工作台记录版本不受支持，请升级客户端");
  const batch = await new AiWorkspaceV2Store(store.sql, workspace).readActiveEntities(userId, [{ kind: "conversation", entityId: conversationId }], store.tenantId);
  const entity = batch.entities[0];
  if (!entity || entity.deleted) return null;
  let conversation: AiWorkspaceConversation;
  try { conversation = validateAiWorkspaceConversationEntity(entity.value); }
  catch { throw new AiError(500, "AI_WORKSPACE_CORRUPT", "当前对话记录未通过校验，请联系管理员"); }
  if (conversation.id !== conversationId) throw new AiError(500, "AI_WORKSPACE_CORRUPT", "当前对话记录标识不一致，请联系管理员");
  return { conversation, revision: entity.revision, schemaVersion: 2, epoch: batch.epoch };
}
