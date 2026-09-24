import type { AiStatus } from "../../../shared/ai";
import type { AiPersonaSnapshot } from "../../../shared/aiPersona";
import type { AiWorkspaceSnapshot } from "../../../shared/aiWorkspace";
import type { AiWorkspaceV2Bootstrap } from "../../../shared/aiWorkspaceV2";
import { ApiRequestError } from "../../lib/api";

export type AiEntry =
  | { kind: "locked"; status: AiStatus }
  | { kind: "onboarding"; status: AiStatus; persona: AiPersonaSnapshot }
  | { kind: "ready-v2"; status: AiStatus; persona: AiPersonaSnapshot; workspace: Extract<AiWorkspaceV2Bootstrap, { schemaVersion: 2 }> }
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
  // A backend older than the V2 rollout has no bootstrap endpoint at all: a 404
  // there means "V2 not deployed", which must fall back to the V1 workspace
  // instead of blocking the whole AI entry. Real failures (network, auth, 5xx)
  // keep failing so they are not masked as a version answer.
  let version: AiWorkspaceV2Bootstrap;
  try {
    version = await api<AiWorkspaceV2Bootstrap>("/api/ai/workspace-v2/bootstrap", options);
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
    version = { schemaVersion: 1 };
  }
  signal.throwIfAborted();
  if (version.schemaVersion === 2) return { kind: "ready-v2", status, persona, workspace: version };
  const workspace = await api<AiWorkspaceSnapshot>("/api/ai/workspace", options);
  signal.throwIfAborted();
  return { kind: "ready", status, persona, workspace };
}
