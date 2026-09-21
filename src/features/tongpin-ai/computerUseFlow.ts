import type {
  ComputerUseAction,
  ComputerUseWindowElement,
  ComputerUseWindowState,
} from "../../../shared/computerUse";
import type { AiComputerPlan } from "../../../shared/ai";

export type ComputerUseDraft =
  | { kind: "click"; elementToken: string }
  | { kind: "type"; elementToken: string; text: string };

export interface ComputerUsePlan {
  action: ComputerUseAction;
  summary: string;
}

export type ComputerUseModelPlan = AiComputerPlan;

export interface ComputerUsePlanningObservation {
  trust: "untrusted-observation";
  appName: string;
  windowTitle: string;
  elements: Array<{ elementToken: string; role: string; label: string; editable: boolean }>;
}

const MAX_TYPE_TEXT_LENGTH = 200;
const EDITABLE_ELEMENT_ROLES = new Set([
  "axsearchfield",
  "axtextarea",
  "axtextfield",
  "edit",
  "editcontrol",
  "searchbox",
  "searchfield",
  "textarea",
  "textfield",
  "textbox",
]);

function cleanLabel(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

export function validLiteralText(value: string) {
  return (
    value.trim().length > 0 &&
    [...value].length <= MAX_TYPE_TEXT_LENGTH &&
    !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(value)
  );
}

/**
 * Computer instructions may contain passwords or other secrets. The live
 * request stays in the short-lived panel state, while workspace persistence
 * receives only this code-owned marker.
 */
export function computerUseConversationRequestMessage(_liveRequest: string) {
  return "已发起 @computer 安全电脑操作（具体指令未写入聊天记录）。";
}

export function actionableComputerElements(state: ComputerUseWindowState) {
  return state.elements.filter(
    (element): element is ComputerUseWindowElement & { elementToken: string } =>
      Boolean(element.elementToken && element.enabled !== false && cleanLabel(element.label ?? "")),
  );
}

/**
 * Keep this allowlist deliberately narrow. The native driver still validates
 * the fresh element token; this check prevents the model/UI from treating an
 * arbitrary focused control as a text destination.
 */
export function isEditableComputerElement(
  element: ComputerUseWindowElement,
): element is ComputerUseWindowElement & { elementToken: string } {
  const role = element.role.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
  return Boolean(
    element.elementToken &&
    element.enabled !== false &&
    cleanLabel(element.label ?? "") &&
    EDITABLE_ELEMENT_ROLES.has(role),
  );
}

export function editableComputerElements(state: ComputerUseWindowState) {
  return state.elements.filter(isEditableComputerElement);
}

export function computerUsePlanningObservation(
  state: ComputerUseWindowState,
): ComputerUsePlanningObservation {
  return {
    trust: "untrusted-observation",
    appName: cleanLabel(state.appName).slice(0, 160),
    windowTitle: cleanLabel(state.windowTitle).slice(0, 160),
    elements: actionableComputerElements(state).slice(0, 60).map(element => ({
      elementToken: element.elementToken,
      role: cleanLabel(element.role).slice(0, 80),
      label: cleanLabel(element.label ?? "").slice(0, 160),
      editable: isEditableComputerElement(element),
    })),
  };
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}

export function validateComputerUseModelPlan(
  value: unknown,
  originalPrompt: string,
  state: ComputerUseWindowState,
): ComputerUseModelPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (!onlyKeys(root, ["kind", "summary", "action"]) || root.kind !== "computer") return null;
  if (
    typeof root.summary !== "string" ||
    !root.summary.trim() ||
    [...root.summary].length > 240 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(root.summary)
  ) return null;
  if (!root.action || typeof root.action !== "object" || Array.isArray(root.action)) return null;
  const action = root.action as Record<string, unknown>;

  if (action.kind === "click") {
    if (!onlyKeys(action, ["kind", "elementToken"]) || typeof action.elementToken !== "string") return null;
    if (!actionableComputerElements(state).some(element => element.elementToken === action.elementToken)) return null;
    return {
      kind: "computer",
      summary: root.summary.trim(),
      action: { kind: "click", elementToken: action.elementToken },
    };
  }

  if (action.kind === "type") {
    if (!onlyKeys(action, ["kind", "elementToken", "text"]) || typeof action.elementToken !== "string" || typeof action.text !== "string") return null;
    if (!validLiteralText(action.text) || !originalPrompt.includes(action.text)) return null;
    if (!editableComputerElements(state).some(element => element.elementToken === action.elementToken)) return null;
    return {
      kind: "computer",
      summary: root.summary.trim(),
      action: { kind: "type", elementToken: action.elementToken, text: action.text },
    };
  }
  return null;
}

export function buildComputerUsePlan(
  state: ComputerUseWindowState,
  draft: ComputerUseDraft,
): ComputerUsePlan | null {
  if (!state.snapshotId) return null;
  const windowName = `${state.appName} — ${state.windowTitle}`;

  if (draft.kind === "type") {
    if (!validLiteralText(draft.text)) return null;
    const element = editableComputerElements(state).find(
      (candidate) => candidate.elementToken === draft.elementToken,
    );
    if (!element) return null;
    return {
      action: {
        kind: "type",
        target: state.target,
        snapshotId: state.snapshotId,
        elementToken: element.elementToken,
        text: draft.text,
      },
      summary: `在「${windowName}」的“${cleanLabel(element.label ?? element.role)}”中输入 ${[...draft.text].length} 个字符（不含回车）`,
    };
  }

  const element = actionableComputerElements(state).find(
    (candidate) => candidate.elementToken === draft.elementToken,
  );
  if (!element) return null;
  return {
    action: {
      kind: "click",
      target: state.target,
      snapshotId: state.snapshotId,
      elementToken: element.elementToken,
    },
    summary: `在「${windowName}」单击“${cleanLabel(element.label ?? element.role)}”一次`,
  };
}

export function computerUseResultMessage({
  plan,
  executionOk,
  executionMessage,
  observedAfter,
}: {
  plan: ComputerUsePlan;
  executionOk: boolean;
  executionMessage: string;
  observedAfter: boolean;
}) {
  if (!executionOk) {
    return `${plan.summary}：${executionMessage}。${observedAfter ? "已重新读取目标窗口；不会自动重试。" : "无法重新读取目标窗口；不会自动重试。"}`;
  }
  return `${plan.summary}：${executionMessage}。${observedAfter ? "已重新读取目标窗口，但未自动判定业务结果。" : "未能重新读取目标窗口，因此不能确认业务结果。"}`;
}
