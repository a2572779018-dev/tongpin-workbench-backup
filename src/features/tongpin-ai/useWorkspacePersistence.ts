import { useEffect, useRef, useState } from "react";
import type { AiWorkspaceSaveRequest, AiWorkspaceSnapshot, AiWorkspaceState } from "../../../shared/aiWorkspace";
import { WorkspaceSaveQueue, type WorkspaceSyncStatus } from "./workspaceSync";
import { registerAiLeaveGuard } from "./workspaceLeaveGuard";

export function useWorkspacePersistence(
  initial: AiWorkspaceSnapshot,
  state: AiWorkspaceState,
  write: (body: AiWorkspaceSaveRequest) => Promise<AiWorkspaceSnapshot>,
  accountId: string,
) {
  const active = useRef(true);
  const [status, setStatus] = useState<WorkspaceSyncStatus>("saved");
  const [error, setError] = useState("");
  const [queue] = useState(() => new WorkspaceSaveQueue(initial, write, (next, message = "") => {
    if (active.current) { setStatus(next); setError(message); }
  }));
  const serializedState = JSON.stringify(state);
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
    const changed = queue.setState(JSON.parse(serializedState) as AiWorkspaceState, { flush: false });
    if (!changed) return;
    const timer = window.setTimeout(() => void queue.flush(), 300);
    return () => window.clearTimeout(timer);
  }, [queue, serializedState]);
  return { status, error, retry: () => void queue.flush(), flush: () => queue.flush(),
    flushSaved: () => queue.flushSaved(),
    saveNow: (next: AiWorkspaceState) => queue.saveNow(next),
  };
}
