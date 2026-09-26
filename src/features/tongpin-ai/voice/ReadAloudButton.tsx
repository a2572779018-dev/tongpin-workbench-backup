import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { speechPlayer } from "./speechPlayer";
import { startReading, useOptionalAuth, useSpeechPlayback, useSpeechSupported } from "./voiceHooks";
import "./voice.css";

/** "朗读" action for one settled assistant reply; the same button stops it.
 * Adapted from LibreChat v0.8.7 `HoverButtons.tsx` / `MessageAudio` (toggle
 * between speak and stop on the message's own action row). */
export function ReadAloudButton({ messageId, content }: { messageId: string; content: string }) {
  const auth = useOptionalAuth();
  const supported = useSpeechSupported();
  const { status, error } = useSpeechPlayback(messageId);
  if (!supported) return null;
  const active = status !== "idle";
  return <>
    <button type="button" className={`tp-ai-read-aloud${active ? " is-active" : ""}`} aria-pressed={active}
      aria-label={active ? "停止朗读" : "朗读回复"} title={active ? "停止朗读" : "朗读"}
      onClick={() => {
        if (active) speechPlayer.stop();
        else void startReading({ key: messageId, content, api: auth?.api, accountId: auth?.session?.user.id });
      }}>
      {status === "loading" ? <LoaderCircle size={15} className="tp-ai-voice-spin" aria-hidden="true" /> : active ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
    </button>
    {error ? <span className="tp-ai-read-aloud-error" role="status">{error}</span> : null}
  </>;
}
