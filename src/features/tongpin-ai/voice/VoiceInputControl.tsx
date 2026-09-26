import { ChevronUp, LoaderCircle, Mic, Square, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AI_VOICE_LIMITS } from "../../../../shared/aiVoice";
import { formatAiPoints } from "../quotaFormatting";
import { formatRecordingTime, levelBars, recorderBusy, recordingFileName } from "./recorderState";
import { speechPlayer } from "./speechPlayer";
import { hasChineseVoice, type SpeechVoiceLike } from "./speechText";
import { useVoiceRecorder, type VoiceRecording } from "./useVoiceRecorder";
import { transcribeRecording, voiceErrorMessage } from "./voiceApi";
import { useOptionalAuth, useSpeechSupported, useVoicePreferences, useVoiceSettings } from "./voiceHooks";
import { effectiveVoicePreferences, SPEECH_RATES, writeVoicePreferences, type VoicePreferences } from "./voicePreferences";
import "./voice.css";

const RATE_LABELS: Record<number, string> = { 0.8: "较慢 0.8×", 1: "正常 1×", 1.25: "较快 1.25×", 1.5: "快 1.5×" };

function useChineseSystemVoice(active: boolean): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synthesis = window.speechSynthesis;
    const update = () => {
      const voices = synthesis.getVoices() as SpeechVoiceLike[];
      if (voices.length) setAvailable(hasChineseVoice(voices));
    };
    update();
    synthesis.addEventListener("voiceschanged", update);
    return () => synthesis.removeEventListener("voiceschanged", update);
  }, [active]);
  return available;
}

/**
 * Composer microphone: record up to 60 s with a live level meter, transcribe
 * through 同频's server and put the text into the draft (or send it), plus a
 * small popover for the member's voice preferences. Kept as its own element
 * beside the send button.
 */
export function VoiceInputControl({ disabled = false, onTranscript }: {
  disabled?: boolean;
  onTranscript: (text: string, autoSend: boolean) => void;
}) {
  const auth = useOptionalAuth();
  const api = auth?.api;
  const accountId = auth?.session?.user.id;
  const settings = useVoiceSettings(api, accountId);
  const preferences = useVoicePreferences(accountId);
  const effective = effectiveVoicePreferences(preferences);
  const speechSupported = useSpeechSupported();
  const [open, setOpen] = useState(false);
  const chineseVoice = useChineseSystemVoice(open && settings.speech.engine === "browser");
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const latest = useRef({ api, accountId, onTranscript, autoSend: effective.autoSend });
  latest.current = { api, accountId, onTranscript, autoSend: effective.autoSend };
  // A transcript that returns after the composer left its conversation is dropped.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const recorder = useVoiceRecorder({
    maxMs: Math.min(settings.input.maxSeconds * 1000, AI_VOICE_LIMITS.maxAudioMs),
    stopOnSilence: effective.stopOnSilence,
    onRecorded: recording => { void transcribe(recording); },
  });
  const { state } = recorder;

  async function transcribe(recording: VoiceRecording) {
    const { api: currentApi, accountId: currentAccount } = latest.current;
    if (recording.durationMs < AI_VOICE_LIMITS.minAudioMs || recording.blob.size === 0) {
      recorder.fail({ message: "录音太短，请说完一句话后再点击停止。", canOpenSettings: false }); return;
    }
    if (recording.blob.size > settings.input.maxBytes) {
      recorder.fail({ message: "录音文件过大，单次最多 10 MB、60 秒，请分段录制。", canOpenSettings: false }); return;
    }
    if (!currentApi || !currentAccount) { recorder.fail({ message: "登录已失效，请重新登录后再使用语音输入。", canOpenSettings: false }); return; }
    try {
      const result = await transcribeRecording(currentApi, currentAccount, { blob: recording.blob, durationMs: recording.durationMs, fileName: recordingFileName(recording.mimeType) });
      if (!mounted.current) return;
      const text = result.text.trim();
      if (!text) { recorder.finish("没有识别到说话内容，请靠近麦克风再试一次。"); return; }
      latest.current.onTranscript(text, latest.current.autoSend);
      recorder.finish(recording.stopReason === "limit" ? "已到 60 秒上限，已转写这一段" : undefined);
    } catch (error) {
      if (mounted.current) recorder.fail({ message: voiceErrorMessage(error, "语音转写失败，请稍后重试。"), canOpenSettings: false });
    }
  }

  // Esc cancels a recording before the chat's own Esc-to-stop sees it.
  const { cancel } = recorder;
  useEffect(() => {
    if (state.phase !== "recording") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancel, state.phase]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  // A short status line fades on its own; errors stay until dismissed.
  const { dismiss } = recorder;
  useEffect(() => {
    if (!state.notice || state.phase === "error") return;
    const timer = window.setTimeout(dismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [dismiss, state.notice, state.phase]);

  if (!auth || (!settings.input.enabled && !speechSupported)) return null;

  const update = (patch: Partial<VoicePreferences>) => writeVoicePreferences(accountId, { ...preferences, ...patch });
  const begin = () => {
    speechPlayer.stop();
    setOpen(false);
    void recorder.start(typeof window === "undefined" ? undefined : window.tongpin?.microphone, typeof window === "undefined" ? "" : window.tongpin?.platform ?? "");
  };
  const openSettings = () => { void window.tongpin?.microphone?.openSettings(); };
  const busy = recorderBusy(state);
  const maxLabel = formatRecordingTime(Math.min(settings.input.maxSeconds * 1000, AI_VOICE_LIMITS.maxAudioMs));

  return <div className="tp-ai-voice" ref={rootRef} data-phase={state.phase}>
    {state.phase === "recording" ? <div className="tp-ai-voice-recording" role="group" aria-label="录音中">
      <span className="sr-only" role="status">正在录音，说完后点击停止按钮转写，按 Esc 取消</span>
      <span className="tp-ai-voice-dot" aria-hidden="true" />
      <span className="tp-ai-voice-level" aria-hidden="true">{levelBars(state.levels).map((height, index) => <i key={index} style={{ transform: `scaleY(${height})` }} />)}</span>
      <span className="tp-ai-voice-time">{formatRecordingTime(state.elapsedMs)}<small>/ {maxLabel}</small></span>
      <button type="button" className="tp-ai-voice-cancel" aria-label="取消录音" title="取消录音（Esc）" onClick={() => cancel()}><X size={14} /></button>
      <button type="button" className="tp-ai-voice-stop" aria-label="停止录音并转写" title="停止并转写" onClick={() => recorder.stop()}><Square size={11} fill="currentColor" /></button>
    </div> : state.phase === "transcribing" ? <span className="tp-ai-voice-busy" role="status"><LoaderCircle size={15} className="tp-ai-voice-spin" aria-hidden="true" />正在转写…</span>
      : settings.input.enabled ? <button type="button" className="tp-ai-voice-trigger" aria-label="语音输入" title={`语音输入（单次最长 ${settings.input.maxSeconds} 秒）`}
        disabled={disabled || state.phase === "starting"} aria-busy={state.phase === "starting"} onClick={begin}>
        {state.phase === "starting" ? <LoaderCircle size={17} className="tp-ai-voice-spin" aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
      </button> : null}
    {!busy ? <button type="button" className="tp-ai-voice-options" aria-label="语音设置" title="语音设置" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined}
      onClick={() => { if (state.phase === "error") dismiss(); setOpen(value => !value); }}><ChevronUp size={13} aria-hidden="true" /></button> : null}
    {open ? <div className="tp-ai-voice-popover" id={popoverId} role="dialog" aria-label="语音设置">
      <h3>语音</h3>
      <label className={`tp-ai-voice-mode${settings.input.enabled ? "" : " is-disabled"}`}>
        <input type="checkbox" checked={preferences.conversationMode} disabled={!settings.input.enabled} onChange={event => update({ conversationMode: event.target.checked })} />
        <span><strong>语音对话模式</strong><small>{settings.input.enabled ? "说完停顿约 2 秒自动结束录音并发送，回复完成后自动朗读。" : "管理员尚未开启语音输入。"}</small></span>
      </label>
      <label className={!settings.input.enabled || preferences.conversationMode ? "is-disabled" : undefined}>
        <input type="checkbox" checked={effective.autoSend} disabled={!settings.input.enabled || preferences.conversationMode} onChange={event => update({ autoSend: event.target.checked })} />
        <span>转写后自动发送<small>关闭时文字先放进输入框，可修改后再发送。</small></span>
      </label>
      <label className={preferences.conversationMode ? "is-disabled" : undefined}>
        <input type="checkbox" checked={effective.autoRead} disabled={preferences.conversationMode} onChange={event => update({ autoRead: event.target.checked })} />
        <span>自动朗读回复<small>新回复完成后自动朗读，随时可在回复下方停止。</small></span>
      </label>
      <label className="tp-ai-voice-rate">朗读语速
        <select value={preferences.rate} onChange={event => update({ rate: Number(event.target.value) })}>
          {SPEECH_RATES.map(rate => <option key={rate} value={rate}>{RATE_LABELS[rate]}</option>)}
        </select>
      </label>
      <hr />
      {settings.input.enabled ? <p>语音输入按录音时长计费：每分钟 {formatAiPoints(settings.input.pointsPerMinute)}（按秒计），单次最长 {settings.input.maxSeconds} 秒。</p> : null}
      <p>{settings.speech.engine === "external" ? `朗读使用外部语音服务：每千字 ${formatAiPoints(settings.speech.pointsPer1kChars)}。` : "朗读使用本机系统语音，不消耗同频点。"}</p>
      {settings.speech.engine === "browser" && chineseVoice === false ? <p>这台电脑没有中文系统语音，朗读中文可能不自然。macOS 可在 系统设置 → 辅助功能 → 朗读内容 中添加中文声音；Windows 可在 设置 → 时间和语言 → 语音 中添加。</p> : null}
    </div> : null}
    {state.phase === "error" && state.issue ? <div className="tp-ai-voice-alert" role="alert">
      <p>{state.issue.message}</p>
      <div>
        {state.issue.canOpenSettings ? <button type="button" className="is-primary" onClick={openSettings}>打开系统设置</button> : null}
        <button type="button" onClick={dismiss}>知道了</button>
      </div>
    </div> : state.notice ? <p className="tp-ai-voice-note" role="status">{state.notice}</p> : null}
  </div>;
}

export { useVoiceAutoRead, useVoiceTranscriptInsert } from "./voiceHooks";
