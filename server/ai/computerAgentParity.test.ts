import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { COMPUTER_AGENT_LIMITS, COMPUTER_CANDIDATE_ID, COMPUTER_RESERVED_CANDIDATES, COMPUTER_SECRET_PATTERN, computerRunLimits, validateComputerTaskSpec } from "../../shared/computerAgent";

const require = createRequire(import.meta.url);
const policy = require("../../electron/computer-agent-policy.cjs") as {
  LIMITS: Record<string, number>;
  RESERVED: string[];
  validateTaskSpec: (value: unknown) => unknown;
  validateLimits: (value: unknown) => unknown;
  buildCandidates: (context: unknown) => Array<{ id: string }>;
  emptyTracker: () => unknown;
};

const base = {
  goal: "在微信里给姐姐发送中秋快乐",
  apps: [{ name: "微信", bundleId: "com.tencent.xinWeChat" }],
  parameters: [
    { id: "p1", role: "recipient", label: "联系人", value: "姐姐" },
    { id: "p2", role: "message", label: "消息内容", value: "中秋快乐" },
  ],
  successCheck: "聊天里出现中秋快乐",
  irreversible: { kind: "send_message", summary: "发送消息给「姐姐」：中秋快乐", recipient: "姐姐", content: "中秋快乐" },
  actionKinds: ["click", "type", "key"],
};

const cases: Array<[string, unknown]> = [
  ["valid", base],
  ["no apps", { ...base, apps: [] }],
  ["four apps", { ...base, apps: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] }],
  ["bad bundle", { ...base, apps: [{ name: "微信", bundleId: "not a bundle" }] }],
  ["duplicate app", { ...base, apps: [{ name: "微信" }, { name: "微信" }] }],
  ["secret label", { ...base, parameters: [{ id: "p1", role: "text", label: "支付密码", value: "1234" }], irreversible: null }],
  ["secret value", { ...base, parameters: [{ id: "p1", role: "text", label: "内容", value: "my password is x" }], irreversible: null }],
  ["newline literal", { ...base, parameters: [{ id: "p1", role: "message", label: "内容", value: "a\nb" }], irreversible: null }],
  ["recipient not a parameter", { ...base, irreversible: { ...base.irreversible, recipient: "妹妹" } }],
  ["send without content", { ...base, irreversible: { kind: "send_message", summary: "发送", recipient: "姐姐" } }],
  ["unknown kind", { ...base, actionKinds: ["click", "shell"] }],
  ["no type without parameters", { ...base, parameters: [], irreversible: null }],
  ["delete granted", { ...base, irreversible: { kind: "delete", summary: "删除草稿" } }],
  ["long goal", { ...base, goal: "长".repeat(201) }],
  ["seven parameters", { ...base, parameters: Array.from({ length: 7 }, (_, index) => ({ id: `p${index}`, role: "text", label: "x", value: `v${index}` })), irreversible: null }],
  ["not an object", "task"],
];

describe("Electron policy ↔ shared contract parity", () => {
  it.each(cases)("validates %s identically", (_name, value) => {
    expect(policy.validateTaskSpec(value)).toEqual(validateComputerTaskSpec(value));
  });

  it("shares limits, reserved ids and the secret pattern", () => {
    for (const key of ["maxCandidates", "maxApps", "maxParameters", "maxParameterChars", "maxGoalChars", "maxSummaryChars", "maxSuccessCheckChars", "maxLabelChars", "maxStepsCeiling", "maxMinutesCeiling", "maxObservationElements", "maxObservationTexts", "maxObservationTextChars", "maxDescriptionChars"] as const) {
      expect(policy.LIMITS[key], key).toBe(COMPUTER_AGENT_LIMITS[key]);
    }
    expect(policy.RESERVED).toEqual([...COMPUTER_RESERVED_CANDIDATES]);
    const source = require("node:fs").readFileSync(new URL("../../electron/computer-agent-policy.cjs", import.meta.url), "utf8") as string;
    expect(source).toContain(COMPUTER_SECRET_PATTERN.source);
  });

  it("accepts server limits in main and emits only server-valid candidate ids", () => {
    const limits = computerRunLimits({ maxSteps: 30, maxMinutes: 6, minConfidence: 0.5 });
    expect(policy.validateLimits(limits)).toEqual(limits);
    const task = (validateComputerTaskSpec(base) as { ok: true; task: unknown }).task;
    const candidates = policy.buildCandidates({
      platform: "darwin", task, appStates: [{ name: "微信", running: true, hasWindow: true }],
      target: { app: "微信", pid: 1, windowId: "2", title: "微信", running: true, minimized: false },
      elements: [], axSparse: false, screenshot: null, windowBounds: null, tracker: policy.emptyTracker(), canLaunch: true,
    });
    expect(candidates.length).toBeLessThanOrEqual(COMPUTER_AGENT_LIMITS.maxCandidates);
    for (const candidate of candidates) expect(candidate.id).toMatch(COMPUTER_CANDIDATE_ID);
  });
});
