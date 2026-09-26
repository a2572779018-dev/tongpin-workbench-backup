import { useCallback, useEffect, useRef, useState } from "react";
import type { AiWorkspaceSaveRequest, AiWorkspaceSnapshot, AiWorkspaceState, AiWorkspaceStorageUsage } from "../../../shared/aiWorkspace";
import { WorkspaceSaveQueue, workspaceStateForServer, type WorkspaceSyncStatus } from "./workspaceSync";
import { notifyAiWorkspaceSaved, registerAiLeaveGuard } from "./workspaceLeaveGuard";
import { estimateWorkspaceStorage, workspaceStorageFrom } from "./workspaceStorage";

export function useWorkspacePersistence(
  initial: AiWorkspaceSnapshot,
  state: AiWorkspaceState,
  write: (body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>,
  accountId: string,
) {
  const active = useRef(true);
  // Additive message fields go only to a server that validates them.
  const [serverFeatures] = useState(() => initial.features);
  const forServer = useCallback((next: AiWorkspaceState) => workspaceStateForServer(next, serverFeatures), [serverFeatures]);
  const [status, setStatus] = useState<WorkspaceSyncStatus>("saved");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  // Server-reported snapshot size; a one-time local estimate if an older server omits it.
  const [storage, setStorage] = useState<AiWorkspaceStorageUsage | null>(() =>
    workspaceStorageFrom(initial.storage) ?? (initial.state ? estimateWorkspaceStorage(initial.state) : null));
  const [queue] = useState(() => new WorkspaceSaveQueue(initial, async body => {
    const snapshot = await write(body);
    const reported = workspaceStorageFrom(snapshot.storage);
    if (reported && active.current) setStorage(reported);
    return snapshot;
  }, (next, message = "", code) => {
    if (next === "saved") notifyAiWorkspaceSaved(accountId);
    if (active.current) { setStatus(next); setError(message); setErrorCode(next === "error" || next === "conflict" ? code : undefined); }
  }));
  useEffect(() => registerAiLeaveGuard(accountId, () => queue.flushSaved()), [accountId, queue]);
  useEffect(() => {
    active.current = true;
    const guard = (event: BeforeUnloadEvent) => {
      if (queue.isDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      active.current = false;
      window.removeEventListener("beforeunload", guard);
      // Flush same-account navigation without depending on this component remaining mounted.
      // The write callback's X-Tongpin-Account prevents a later login from receiving old data.
      void queue.flush();
    };
  }, [queue]);
  useEffect(() => {
    // The page memoizes semantic state. Do not stringify a complete workspace while
    // rendering, or repeat the queue's immutable snapshot clone on every UI tick.
    const changed = queue.setState(forServer(state), { flush: false });
    if (!changed) return;
    const timer = window.setTimeout(() => void queue.flush(), 300);
    return () => window.clearTimeout(timer);
  }, [forServer, queue, state]);
  return { status, error, errorCode, storage, retry: () => void queue.flush(), flush: () => queue.flush(),
    flushSaved: () => queue.flushSaved(),
    saveNow: (next: AiWorkspaceState) => queue.saveNow(forServer(next)),
  };
}
