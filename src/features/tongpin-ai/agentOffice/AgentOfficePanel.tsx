import { ChevronDown, Users } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AgentOfficeView } from "./AgentOfficeView";
import { PHASE_LABELS } from "./fallbackModel";
import type { AgentOfficeSnapshot } from "./types";
import "./agentOffice.css";

export interface AgentOfficePanelProps {
  snapshot: AgentOfficeSnapshot | null;
  /** Passed through to <AgentOfficeView>; see its own default. */
  height?: number;
}

const ACTIVE_PHASES = new Set<AgentOfficeSnapshot["phase"]>(["planning", "dispatching", "working", "synthesizing"]);

/**
 * Collapsible "AI 员工办公室" section wrapping <AgentOfficeView>. Open by
 * default while the run is active (planning/dispatching/working/
 * synthesizing), collapsed once it settles (done/failed/cancelled) — the
 * same "auto-derived, user can still override" idea as ReplyProcess's own
 * expand/collapse header, just without a persisted cross-session preference
 * (this section's default is a function of the run's own phase, not a
 * standing viewer setting). Renders nothing when there is no run yet.
 */
export function AgentOfficePanel({ snapshot, height }: AgentOfficePanelProps) {
  const bodyId = useId();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const lastRunIdRef = useRef<string | null>(null);

  const runId = snapshot?.runId ?? null;
  if (lastRunIdRef.current !== runId) {
    // A new run (or the run disappearing) drops any manual override so the
    // next run again opens by default while it's active.
    lastRunIdRef.current = runId;
    if (manualExpanded !== null) setManualExpanded(null);
  }

  // Rendering nothing for a null snapshot happens after the hooks above so
  // hook order stays stable across the null <-> non-null transition.
  if (!snapshot) return null;

  const autoExpanded = ACTIVE_PHASES.has(snapshot.phase);
  const expanded = manualExpanded ?? autoExpanded;
  const statusText = `${PHASE_LABELS[snapshot.phase]} · ${snapshot.workers.length} 位员工`;

  return (
    <section className={`tp-ai-office-panel is-${snapshot.phase}${expanded ? " is-expanded" : ""}`} aria-label="AI 员工办公室">
      <button
        type="button"
        className="tp-ai-office-panel__header"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setManualExpanded(!expanded)}
      >
        <span className="tp-ai-office-panel__badge"><Users size={14} aria-hidden="true" /></span>
        <span className="tp-ai-office-panel__headline">AI 员工办公室</span>
        <span className="tp-ai-office-panel__status">{statusText}</span>
        <ChevronDown size={16} aria-hidden="true" className="tp-ai-office-panel__chevron" />
      </button>
      {expanded ? (
        <div id={bodyId} className="tp-ai-office-panel__body">
          {/* LimeZu's "Modern Interiors" license requires visible credit —
           *  shown in the app's About panel (see electron/main.cjs and
           *  about-panel-options.cjs) rather than here, so this UI stays
           *  free of attribution text; THIRD_PARTY_NOTICES.md still carries
           *  the full notice. */}
          <AgentOfficeView snapshot={snapshot} height={height} />
        </div>
      ) : null}
    </section>
  );
}
