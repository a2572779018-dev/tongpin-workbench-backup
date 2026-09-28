import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("voice wiring in the chat workspace", () => {
  it("keeps the microphone a separate element right before the send/stop control", () => {
    const workspace = source("../ChatWorkspace.tsx");
    const microphone = workspace.indexOf('<VoiceInputControl key={conversationId ?? "new"} disabled={videoBusy} onTranscript={insertVoiceTranscript} />');
    expect(microphone).toBeGreaterThan(workspace.indexOf('aria-label="思考模式"'));
    // The send control is the steer-aware one: stop spinner, steer (supplement) or send.
    const sendControl = workspace.indexOf('{sendMode === "stop" ? (', microphone);
    expect(sendControl).toBeGreaterThan(microphone);
    // Only the 语音通话 button sits between the microphone and the send control.
    const between = workspace.slice(microphone, sendControl).trim().split("\n");
    expect(between).toHaveLength(2);
    expect(between[1]).toContain("<VoiceCallButton ");
    expect(workspace.indexOf(') : sendMode === "steer" ? (', sendControl)).toBeGreaterThan(sendControl);
    expect(workspace).toContain("useVoiceAutoRead(conversationId, lastMessage);");
    // Only a plain text turn may be sent automatically.
    expect(workspace).toContain('composerTool === "text" && !videoOpen ? submitMessage() : composerRef.current?.focus()');
  });

  it("puts 朗读 next to copy on a settled assistant reply only", () => {
    const row = source("../ChatMessageRow.tsx");
    const controls = row.slice(row.indexOf('message.role === "assistant" && message.content && !["thinking", "typing", "error"]'));
    expect(controls).toContain("<ReadAloudButton messageId={message.id} content={message.content} />");
  });

  it("sends each spoken turn through the composer's own send, the same channel as typing", () => {
    const workspace = source("../ChatWorkspace.tsx");
    expect(workspace).toContain("{voiceCall ? <VoiceCallButton ");
    // The call has one stable slot above the composer / computer panel, so an operation never ends it.
    expect(workspace).toContain("{callActive ? (\n            <VoiceCallPanel ");
    expect(workspace).toContain(": callActive ? null : (");
    // A spoken turn becomes the draft and is sent by submitMessage (tools, mentions, attachments, steer).
    const spoken = workspace.slice(workspace.indexOf("function submitSpokenTurn("), workspace.indexOf("  function submitMessage(event"));
    expect(spoken).toContain("onDraftChange(text);");
    expect(spoken).toContain("submitMessage();");
    const page = source("../../../pages/TongpinAIPage.tsx");
    expect(page).toContain("voiceCall={voiceCallSupport}");
    expect(page).not.toContain("submitVoiceCallTurn");
    expect(page).toContain("...(voiceCallActiveRef.current && generationTool === \"text\" ? { voiceCall: true as const } : {}),");
  });

  it("never records before the member presses the microphone", () => {
    const recorder = source("./useVoiceRecorder.ts");
    const control = source("./VoiceInputControl.tsx");
    expect(recorder.match(/getUserMedia\(/g)).toHaveLength(1);
    expect(recorder.indexOf("getUserMedia(")).toBeGreaterThan(recorder.indexOf("const start = useCallback(async"));
    expect(control).toContain("onClick={begin}");
    expect(control.match(/recorder\.start\(/g)).toHaveLength(1);
  });
});
