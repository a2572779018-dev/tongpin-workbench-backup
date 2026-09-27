import type { AiWorkspaceConversation, AiWorkspaceState } from "../../shared/aiWorkspace";
import type { AiSql } from "./storage";

/*
 * Post-commit notifications for workspace writes. The workspace repositories
 * stay unaware of their observers: they announce a committed V1 snapshot save
 * or a committed V2 conversation write, and whatever registered for that
 * database (member history recall) reacts. Observers run after the write's
 * own transaction has committed, never inside it, and can never fail it.
 */

export interface AiWorkspaceV1SavedEvent { tenantId: string; userId: string; revision: number; state: AiWorkspaceState }
/** A committed V2 message append or conversation metadata put. */
export interface AiWorkspaceV2ConversationEvent { tenantId: string; userId: string; revision: number; conversation: AiWorkspaceConversation }

export interface AiWorkspaceWriteObserver {
  v1Saved?(event: AiWorkspaceV1SavedEvent): void;
  v2ConversationWritten?(event: AiWorkspaceV2ConversationEvent): void;
}

const observers = new WeakMap<AiSql, AiWorkspaceWriteObserver>();

/** One observer per database handle; registering again replaces it (idempotent per service tree). */
export function setAiWorkspaceWriteObserver(sql: AiSql, observer: AiWorkspaceWriteObserver): void {
  observers.set(sql, observer);
}

export function hasAiWorkspaceWriteObserver(sql: AiSql): boolean { return observers.has(sql); }

export function notifyAiWorkspaceV1Saved(sql: AiSql, event: AiWorkspaceV1SavedEvent): void {
  try { observers.get(sql)?.v1Saved?.(event); } catch { /* A derived index never fails a committed save. */ }
}

export function notifyAiWorkspaceV2ConversationWritten(sql: AiSql, event: AiWorkspaceV2ConversationEvent): void {
  try { observers.get(sql)?.v2ConversationWritten?.(event); } catch { /* A derived index never fails a committed write. */ }
}
