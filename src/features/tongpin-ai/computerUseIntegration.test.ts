import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./ComputerUsePanel.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
const auth = readFileSync(new URL("../../auth/AuthContext.tsx", import.meta.url), "utf8");

describe("@computer desktop integration", () => {
  it("intercepts @computer before video and ordinary chat submission", () => {
    const submit = workspace.slice(
      workspace.indexOf("function submitMessage"),
      workspace.indexOf("async function addFiles"),
    );
    expect(submit.indexOf('mentionedTools[0] === "computer"')).toBeGreaterThan(-1);
    expect(submit.indexOf('mentionedTools[0] === "computer"')).toBeLessThan(submit.indexOf("if (videoOpen)"));
    expect(submit.indexOf("onOpenComputer(draft.trim())")).toBeLessThan(submit.indexOf("onSubmit(imagePlan"));
    expect(page).toContain("onOpenComputer={beginComputerUse}");
  });

  it("keeps the action sequence observe, native approval, one execute, observe", () => {
    const observe = panel.slice(panel.indexOf("async function observeTarget"), panel.indexOf("async function requestModelPlan"));
    const execute = panel.slice(panel.indexOf("async function executePlan"), panel.indexOf("async function closeSession"));
    expect(observe.indexOf("getWindowState")).toBeGreaterThan(-1);
    expect(observe.indexOf("requestModelPlan(result.value)")).toBeGreaterThan(observe.indexOf("getWindowState"));
    const approvalAt = execute.indexOf("requestActionApproval");
    const actionAt = execute.indexOf("executeApprovedAction");
    const observeAt = execute.indexOf("getWindowState", actionAt);
    expect(approvalAt).toBeGreaterThan(-1);
    expect(actionAt).toBeGreaterThan(approvalAt);
    expect(observeAt).toBeGreaterThan(actionAt);
    expect(execute.match(/executeApprovedAction/g)).toHaveLength(1);
    expect(panel).not.toContain("kind: \"shell\"");
    expect(panel).not.toContain("x:");
    expect(panel).not.toContain("y:");
  });

  it("does not send observed screenshots or trees to chat/backend persistence", () => {
    expect(panel).not.toContain("/api/ai/");
    expect(panel).not.toContain("fetch(");
    expect(panel).not.toContain("treeMarkdown");
    expect(page).toContain('outputFormat: "computer_plan"');
    expect(page).toContain('api<AiChatPreflight>("/api/ai/preflight"');
    expect(page).toContain('api<AiChatResponse');
    expect(page).toContain('>("/api/ai/chat"');
    expect(page).toContain("computerUsePlanningObservation(snapshot)");
    expect(page).toContain("appendComputerResult(request.conversationId, content)");
    expect(page).not.toContain("appendComputerResult(request.conversationId, state");
  });

  it("stops the native session on account change and error-boundary logout", () => {
    expect(auth).toContain("await window.tongpin?.computerUse?.stopSession()");
    expect(page).toContain("void bridge.stopSession()");
  });
});
