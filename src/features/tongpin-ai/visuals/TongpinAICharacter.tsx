import { Component, lazy, memo, Suspense, type ReactNode } from "react";
import type { AiPersonaExpression } from "../../../../shared/aiPersona";
import { resolveCharacterExpression, type CharacterActivity } from "./characterExpression";

const Fleur = lazy(() => import("./fleur/FleurCharacter").then(module => ({ default: module.FleurCharacter })));

export class CharacterBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <span className="tp-ai-character-placeholder">✿</span> : this.props.children;
  }
}

/** One active identity in the workspace; exported geometry is loaded only when it is shown. */
export const TongpinAICharacter = memo(function TongpinAICharacter({
  expression = "auto", activity = "idle", paused = false, className = "",
}: {
  expression?: AiPersonaExpression;
  activity?: CharacterActivity;
  paused?: boolean;
  className?: string;
}) {
  const frame = resolveCharacterExpression(expression, activity);
  return <div className={`tp-ai-character ${className}`} aria-hidden="true">
    <CharacterBoundary><Suspense fallback={<span className="tp-ai-character-placeholder">✿</span>}>
      <Fleur {...frame} paused={paused} framing="compact" impressionPlayback="hold" followPointer interactive={false} texture={false} className="tp-ai-character__figure" />
    </Suspense></CharacterBoundary>
  </div>;
});
