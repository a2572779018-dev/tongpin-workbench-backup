import { buildFallbackRows, type FallbackRow } from "./fallbackModel";
import { portraitForRecipe } from "./portraits";
import { COORDINATOR_RECIPE_KEY, recipeForWorker } from "./roster";
import type { AgentOfficeSnapshot } from "./types";
import "./agentOffice.css";

export interface AgentOfficeFallbackProps {
  snapshot: AgentOfficeSnapshot;
  /** Why the canvas scene isn't showing — shown as a small note above the list. */
  reason?: "no-webgl" | "reduced-motion-only";
}

const COORDINATOR_ROW_ID = "__coordinator__";

/** Same recipe rule OfficeSceneController uses to pick a canvas character —
 *  kept in lockstep so a worker never appears as a different LimeZu character
 *  between the canvas scene and this fallback. */
function portraitFor(row: FallbackRow): string {
  return portraitForRecipe(row.id === COORDINATOR_ROW_ID ? COORDINATOR_RECIPE_KEY : recipeForWorker(row.id));
}

/**
 * The compact, canvas-free view of the same information the Pixi scene
 * shows: used when WebGL is unavailable or its context was lost and recovery
 * gave up (see glRecovery.ts / loadStrategy.ts). Built from the same
 * `buildFallbackRows` the hover/click detail card uses, so the two surfaces
 * can never disagree about what a worker's status or result says. Each row
 * also shows the same tiny LimeZu portrait the canvas scene would seat at
 * that desk (see portraits.ts) so this list still reads as "the office", not
 * a bare status table.
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
            <img
              className="tp-ai-office-fallback__portrait"
              src={portraitFor(row)}
              alt=""
              aria-hidden="true"
              width={20}
              height={20}
            />
            <strong>{row.label}</strong>
            {row.title ? <span className="tp-ai-office-fallback__title">{row.title}</span> : null}
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
