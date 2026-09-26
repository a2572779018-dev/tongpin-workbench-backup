import { buildFallbackRows } from "./fallbackModel";
import type { AgentOfficeSnapshot } from "./types";
import "./agentOffice.css";

export interface AgentOfficeFallbackProps {
  snapshot: AgentOfficeSnapshot;
  /** Why the canvas scene isn't showing — shown as a small note above the list. */
  reason?: "no-webgl" | "reduced-motion-only";
}

/**
 * The compact, canvas-free view of the same information the Pixi scene
 * shows: used when WebGL is unavailable or its context was lost and recovery
 * gave up (see glRecovery.ts / loadStrategy.ts). Built from the same
 * `buildFallbackRows` the hover/click detail card uses, so the two surfaces
 * can never disagree about what a worker's status or result says.
 */
export function AgentOfficeFallback({ snapshot, reason }: AgentOfficeFallbackProps) {
  const rows = buildFallbackRows(snapshot);
  return (
    <div className="tp-ai-office-fallback" role="list" aria-label="AI 员工办公室（列表视图）">
      {reason === "no-webgl" ? (
        <p className="tp-ai-office-fallback__note">当前设备无法渲染办公室动画，已切换为列表视图。</p>
      ) : null}
      {rows.map((row) => (
        <div className="tp-ai-office-fallback__row" role="listitem" key={row.id}>
          <div className="tp-ai-office-fallback__row-head">
            <strong>{row.label}</strong>
            <span className="tp-ai-office-fallback__status">{row.statusText}</span>
            {row.elapsedText ? <span className="tp-ai-office-fallback__elapsed">{row.elapsedText}</span> : null}
          </div>
          {row.task ? <p className="tp-ai-office-fallback__task">{row.task}</p> : null}
          {row.resultSummary ? (
            <p className="tp-ai-office-fallback__result">
              {row.resultSummary}
              {typeof row.sourceCount === "number" ? `（来源 ${row.sourceCount} 条）` : ""}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
