import { Mic, Phone, PhoneOff, Square } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AI_VOICE_LIMITS } from "../../../../../shared/aiVoice";
import { classifyMicrophoneError, ensureMicrophoneAccess, microphoneIssue } from "../micPermission";
import { speechPlayer } from "../speechPlayer";
import { holdVoiceCapture } from "../useVoiceRecorder";
import { synthesizeSpeech, transcribeRecording, voiceErrorMessage } from "../voiceApi";
import { useOptionalAuth, useVoiceSettings } from "../voiceHooks";
import { readVoicePreferences } from "../voicePreferences";
import { CallSpeaker } from "./callSpeaker";
import { CALL_AUDIO_CONSTRAINTS, createCallVad, utteranceWav } from "./sileroVad";
import { VoiceCallController, type CallPhase, type CallReplyLike, type VoiceCallTurnResult } from "./voiceCallController";
import "./voiceCall.css";

/**
 * 语音通话 panel, the React port of Open WebUI v0.6.5's CallOverlay
 * (BSD-3-Clause, Copyright (c) 2023-2025 Timothy Jaeryang Baek): a circle that
 * follows the microphone level while listening, a waiting animation while the
 * AI thinks, the status line ("Listening..." / "Thinking..." / "Tap to
 * interrupt") and the end-call button. It takes the composer's place, so the
 * conversation above keeps showing what was said. The camera/screen-share
 * input and emoji mode of Open WebUI are not ported.
 */

export type { VoiceCallTurnResult } from "./voiceCallController";

const STATUS: Record<CallPhase, string> = {
  starting: "正在接通…",
  listening: "请说话，说完停顿一下",
  hearing: "正在听…",
  transcribing: "正在识别…",
  thinking: "正在思考…",
  speaking: "正在回答 · 点圆圈可打断",
  failed: "通话没能开始",
};

export function VoiceCallButton({ disabled, onStart }: { disabled?: boolean; onStart: () => void }) {
  const auth = useOptionalAuth();
  const settings = useVoiceSettings(auth?.api, auth?.session?.user.id);
  if (!settings.input.enabled) return null;
  return <button type="button" className="tp-ai-call-button" aria-label="语音通话" title="语音通话：直接说话，AI 用语音回答" disabled={disabled} onClick={onStart}>
    <Phone size={17} />
  </button>;
}

interface VoiceCallPanelProps {
  messages: readonly CallReplyLike[];
  onSubmitTurn: (text: string) => VoiceCallTurnResult;
  onStopReply?: () => void;
  onClose: () => void;
}

export function VoiceCallPanel({ messages, onSubmitTurn, onStopReply, onClose }: VoiceCallPanelProps) {
  const auth = useOptionalAuth();
  const api = auth?.api;
  const accountId = auth?.session?.user.id;
  const settings = useVoiceSettings(api, accountId);
  const latest = useRef({ api, accountId, engine: settings.speech.engine, onSubmitTurn, onStopReply });
  latest.current = { api, accountId, engine: settings.speech.engine, onSubmitTurn, onStopReply };
  const orbRef = useRef<HTMLSpanElement>(null);

  const [controller] = useState(() => {
    let call: VoiceCallController;
    const speaker = new CallSpeaker({
      get engine() { return latest.current.engine === "external" && latest.current.api && latest.current.accountId ? "external" : "browser"; },
      get rate() { return readVoicePreferences(latest.current.accountId).rate; },
      synthesize: (text, signal) => synthesizeSpeech(latest.current.api!, latest.current.accountId!, text, signal),
      onSpeaking: sentence => call.speaking(sentence),
      onDrained: () => call.drained(),
    });
    call = new VoiceCallController({
      transcribe: async audio => {
        const { api: signedIn, accountId: account } = latest.current;
        if (!signedIn || !account) throw new Error("登录已失效，请重新登录。");
        const durationMs = Math.min(AI_VOICE_LIMITS.maxAudioMs, Math.round(audio.length / 16));
        const result = await transcribeRecording(signedIn, account, { blob: await utteranceWav(audio), durationMs, fileName: "call.wav" });
        return result.text.trim();
      },
      submitTurn: text => latest.current.onSubmitTurn(text),
      stopReply: () => latest.current.onStopReply?.(),
      errorMessage: error => voiceErrorMessage(error, "没能识别这段话，请再说一遍。"),
    }, speaker);
    return call;
  });
  const view = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => { controller.updateMessages(messages); }, [controller, messages]);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let frame = 0;
    let level = 0;
    controller.open();
    const release = holdVoiceCapture();
    speechPlayer.stop();
    let wakeLock: { release(): Promise<void> } | null = null;
    void (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen")
      .then(lock => { if (cancelled) void lock.release(); else wakeLock = lock; }).catch(() => undefined);
    const paint = () => {
      frame = 0;
      orbRef.current?.style.setProperty("--call-level", level.toFixed(3));
    };
    void (async () => {
      const bridge = typeof window === "undefined" ? undefined : window.tongpin?.microphone;
      const platform = typeof window === "undefined" ? "" : window.tongpin?.platform ?? "";
      const access = await ensureMicrophoneAccess(bridge);
      if (cancelled) return;
      if (!access.ok) { controller.fail(microphoneIssue(access.reason, platform, Boolean(bridge))); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS }); }
      catch (error) { if (!cancelled) controller.fail(microphoneIssue(classifyMicrophoneError(error), platform, Boolean(bridge))); return; }
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      try {
        const vad = await createCallVad(stream, {
          onSpeechStart: () => controller.speechStarted(),
          onSpeechEnd: audio => controller.speechEnded(audio),
          onMisfire: () => controller.misfire(),
          onLevel: value => {
            level = Math.min(1, value * 8);
            if (!frame) frame = requestAnimationFrame(paint);
          },
        });
        const opened = stream;
        controller.attach({
          resume: () => vad.start(),
          pause: () => vad.pause(),
          destroy: async () => { try { await vad.destroy(); } catch { /* Already stopped. */ } opened.getTracks().forEach(track => track.stop()); },
        });
      } catch {
        stream.getTracks().forEach(track => track.stop());
        if (!cancelled) controller.fail({ message: "语音检测没能启动，请关闭通话后重新打开；如果仍然不行，请重启同频。", canOpenSettings: false });
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      controller.hangUp();
      if (controller.phase === "failed" || controller.phase === "starting") stream?.getTracks().forEach(track => track.stop());
      void wakeLock?.release().catch(() => undefined);
      release();
    };
  }, [controller]);

  const busy = view.phase === "thinking" || view.phase === "transcribing";
  const canInterrupt = view.phase === "thinking" || view.phase === "speaking";
  const hangUp = () => { controller.hangUp(); onClose(); };
  return <section className="tp-ai-call" data-phase={view.phase} role="region" aria-label="语音通话">
    <button type="button" className="tp-ai-call__orb-button" onClick={() => { if (canInterrupt) controller.interrupt(); }} aria-label={canInterrupt ? "打断 AI" : STATUS[view.phase]} disabled={!canInterrupt}>
      {busy ? <svg className="tp-ai-call__dots" viewBox="0 0 24 24" aria-hidden="true"><circle cx="4" cy="12" r="3" /><circle cx="12" cy="12" r="3" /><circle cx="20" cy="12" r="3" /></svg>
        : <span ref={orbRef} className="tp-ai-call__orb" aria-hidden="true">{view.phase === "listening" || view.phase === "hearing" ? <Mic size={18} /> : null}</span>}
    </button>
    <div className="tp-ai-call__body" aria-live="polite">
      <p className="tp-ai-call__status">{view.fatal ? view.fatal.message : STATUS[view.phase]}</p>
      {!view.fatal && (view.saying || view.heard) ? <p className="tp-ai-call__caption">{view.saying ? <><b>AI</b>{view.saying}</> : <><b>你</b>{view.heard}</>}</p> : null}
      {!view.fatal && view.notice ? <p className="tp-ai-call__notice" role="status">{view.notice}</p> : null}
      {view.fatal?.canOpenSettings ? <button type="button" className="tp-ai-call__settings" onClick={() => { void window.tongpin?.microphone?.openSettings(); }}>打开麦克风设置</button> : null}
    </div>
    <div className="tp-ai-call__actions">
      <button type="button" className="tp-ai-call__interrupt" onClick={() => controller.interrupt()} disabled={!canInterrupt}><Square size={12} fill="currentColor" />打断</button>
      <button type="button" className="tp-ai-call__hangup" onClick={hangUp}><PhoneOff size={16} />挂断</button>
    </div>
  </section>;
}
