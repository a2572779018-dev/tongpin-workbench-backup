import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./ComputerRunPanel.tsx", import.meta.url), "utf8");
const loop = readFileSync(new URL("./computerExecutor.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
const auth = readFileSync(new URL("../../auth/AuthContext.tsx", import.meta.url), "utf8");

describe("unified computer executor integration", () => {
  it("intercepts @computer before video and ordinary chat submission", () => {
    const submit = workspace.slice(
      workspace.indexOf("function submitMessage"),
      workspace.indexOf("async function addFiles"),
    );
    expect(submit.indexOf('mentionedTools[0] === "computer"')).toBeGreaterThan(-1);
    expect(submit.indexOf('mentionedTools[0] === "computer"')).toBeLessThan(submit.indexOf("if (videoOpen)"));
    expect(submit.indexOf("onOpenComputer(draft.trim())")).toBeLessThan(submit.lastIndexOf("onSubmit()"));
    expect(page).toContain("onOpenComputer={beginComputerUse}");
  });

  it("enters the same executor from natural-language dispatch with the member's own words", () => {
    expect(page).toContain("beginComputerUse(originalPrompt, conversationId, decision.prompt)");
    expect(page).toContain("computerPanel={computerRequest ? <ComputerRunPanel");
    expect(workspace).toContain("computerRequest && computerPanel ? computerPanel");
    // A tier without the computer capability is told before any model call.
    const send = page.slice(page.indexOf("async function sendMessage"), page.indexOf('api<AiChatPreflight>("/api/ai/preflight"', page.indexOf("async function sendMessage")));
    expect(send).toContain("computerOperationIntent(content)");
    expect(send).toContain("computerTierNotice(aiStatus?.computerTiers, origin.mode)");
    const begin = page.slice(page.indexOf("function beginComputerUse"), page.indexOf("function recordComputerResult"));
    expect(begin.indexOf("computerTierNotice(aiStatus?.computerTiers, mode)")).toBeLessThan(begin.indexOf("setComputerRequest("));
  });

  it("runs observe → Jev decision → main-process execute, one execution per decision", () => {
    const body = loop.slice(loop.indexOf("for (;;)"));
    const observeAt = body.indexOf("bridge.observe()");
    const decideAt = body.indexOf("/decide");
    const executeAt = body.indexOf("bridge.execute(");
    expect(observeAt).toBeGreaterThan(-1);
    expect(decideAt).toBeGreaterThan(observeAt);
    expect(executeAt).toBeGreaterThan(decideAt);
    expect(loop.match(/bridge\.execute\(/g)).toHaveLength(1);
    expect(loop.match(/bridge\.consent\(/g)).toHaveLength(1);
    expect(loop).not.toContain("callTool");
  });

  it("keeps the instruction out of chat persistence and sends only computer routes", () => {
    expect(page).toContain("content: computerUseConversationRequestMessage(originalPrompt)");
    expect(page).toContain("onFinish={result => recordComputerResult(result.summary)}");
    expect(page).toContain("appendComputerResult(request.conversationId, content)");
    expect(page).not.toContain('outputFormat: "computer_plan"');
    expect(panel).not.toContain("/api/ai/");
    expect(panel).not.toContain("localStorage");
    expect([...loop.matchAll(/"\/api\/ai\/[^"`]*|`\/api\/ai\/[^`]*`/g)].map(match => match[0]).every(path => path.includes("/api/ai/computer/"))).toBe(true);
    expect(loop).not.toContain("treeMarkdown");
  });

  it("stops the native session on account change and error-boundary logout", () => {
    expect(auth).toContain("await window.tongpin?.computerUse?.stopSession()");
    expect(page).toContain("void bridge.stopSession()");
  });
});
