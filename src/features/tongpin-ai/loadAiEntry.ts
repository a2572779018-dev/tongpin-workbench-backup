import type { AiStatus } from "../../../shared/ai";
import type { AiPersonaSnapshot } from "../../../shared/aiPersona";
import type { AiWorkspaceSnapshot } from "../../../shared/aiWorkspace";

export type AiEntry =
  | { kind: "locked"; status: AiStatus }
  | { kind: "onboarding"; status: AiStatus; persona: AiPersonaSnapshot }
  | { kind: "ready"; status: AiStatus; persona: AiPersonaSnapshot; workspace: AiWorkspaceSnapshot };

type EntryApi = <T>(path: string, init?: RequestInit) => Promise<T>;

// Fail closed before retrieving personal content. The server is authoritative;
// neither a saved name nor a zero-balance record grants AI access.
export async function loadAiEntry(api: EntryApi, accountId: string, signal: AbortSignal): Promise<AiEntry> {
  const options = { headers: { "X-Tongpin-Account": accountId }, signal };
  const status = await api<AiStatus>("/api/ai/status", options);
  signal.throwIfAborted();
  if (status.accessGranted !== true) return { kind: "locked", status };
  const persona = await api<AiPersonaSnapshot>("/api/ai/persona", options);
  signal.throwIfAborted();
  if (!persona.profile.onboardingComplete) return { kind: "onboarding", status, persona };
  const workspace = await api<AiWorkspaceSnapshot>("/api/ai/workspace", options);
  signal.throwIfAborted();
  return { kind: "ready", status, persona, workspace };
}
