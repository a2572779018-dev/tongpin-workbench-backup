"use strict";

/**
 * Pure policy for the unified computer executor host (Electron main):
 * task-spec re-validation, observation projection, immutable closed candidate
 * construction, authorization/scope checks and consent text.
 *
 * The closed-candidate pattern — frozen candidates bound to one capture,
 * reserved `reobserve`/`abstain` (plus `done`), complete natural-language
 * descriptions, choice answers resolved only through the original table,
 * a distinct explicit foreground candidate after a background refusal, and
 * never replaying an uncertain action — is adapted from the MIT-licensed
 * trycua/cua `libs/cua-driver/examples/jev-use` (typescript/core.ts,
 * run.ts; commit e8777e6). See THIRD_PARTY_NOTICES.md.
 *
 * Every string read from the screen is untrusted observation data. It may be
 * quoted inside a description, but it never selects, authorizes or widens an
 * action; authorization is decided here from the consent grant and
 * application-owned state only.
 */

const LIMITS = Object.freeze({
  maxCandidates: 32,
  maxApps: 3,
  maxParameters: 6,
  maxParameterChars: 200,
  maxGoalChars: 200,
  maxSummaryChars: 120,
  maxSuccessCheckChars: 200,
  maxLabelChars: 20,
  maxStepsCeiling: 50,
  maxMinutesCeiling: 15,
  maxObservationElements: 60,
  maxObservationTexts: 40,
  maxObservationTextChars: 80,
  maxDescriptionChars: 400,
  quoteChars: 40,
});
const ACTION_KINDS = ["activate_app", "click", "type", "key", "scroll"];
const PARAMETER_ROLES = ["recipient", "message", "search", "text"];
const IRREVERSIBLE_KINDS = ["send_message", "submit", "delete", "payment", "other"];
const RESERVED = ["reobserve", "abstain", "done"];
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const SECRET = /(?:密码|口令|验证码|校验码|动态码|支付密码|密钥|私钥|助记词|银行卡号|信用卡号|身份证号|password|passcode|passwd|one[\s_-]*time[\s_-]*code|verification[\s_-]*code|api[\s_-]*key|secret|private[\s_-]*key|seed[\s_-]*phrase|mnemonic|\bcvv\b|\botp\b|\bpin\b)/iu;
const PARAMETER_ID = /^[a-z][a-z0-9_]{0,15}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function singleLine(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean || CONTROL.test(clean) || [...clean].length > max) return null;
  return clean;
}
function literal(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || CONTROL.test(clean) || [...clean].length > max) return null;
  return clean;
}

/** Mirror of shared/computerAgent.ts validateComputerTaskSpec (parity-tested). */
function validateTaskSpec(value) {
  const root = record(value);
  const fail = (message) => ({ ok: false, code: "invalid", message });
  if (!root) return fail("任务结构不正确");
  const goal = singleLine(root.goal, LIMITS.maxGoalChars);
  if (!goal) return fail("任务目标缺失或过长");
  if (!Array.isArray(root.apps) || !root.apps.length || root.apps.length > LIMITS.maxApps) return fail("目标应用需为 1 到 3 个");
  const apps = [];
  for (const raw of root.apps) {
    const item = record(raw);
    const name = item ? singleLine(item.name, 40) : null;
    if (!item || !name) return fail("目标应用名称不正确");
    let bundleId;
    if (item.bundleId !== undefined && item.bundleId !== null && item.bundleId !== "") {
      if (typeof item.bundleId !== "string" || item.bundleId.length > 150 || !BUNDLE_ID.test(item.bundleId)) return fail("目标应用标识不正确");
      bundleId = item.bundleId;
    }
    if (apps.some((app) => app.name === name || (bundleId && app.bundleId === bundleId))) return fail("目标应用重复");
    apps.push({ name, ...(bundleId ? { bundleId } : {}) });
  }
  if (root.parameters !== undefined && !Array.isArray(root.parameters)) return fail("任务参数格式不正确");
  const rawParameters = Array.isArray(root.parameters) ? root.parameters : [];
  if (rawParameters.length > LIMITS.maxParameters) return fail("任务参数最多 6 个");
  const parameters = [];
  for (const raw of rawParameters) {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !PARAMETER_ID.test(item.id) || parameters.some((parameter) => parameter.id === item.id)) return fail("任务参数编号不正确");
    if (!PARAMETER_ROLES.includes(item.role)) return fail("任务参数类型不正确");
    const label = singleLine(item.label, LIMITS.maxLabelChars);
    const text = literal(item.value, LIMITS.maxParameterChars);
    if (!label || !text) return fail("任务参数内容缺失、过长或包含换行");
    if (SECRET.test(label) || SECRET.test(text)) return { ok: false, code: "secret", message: "电脑操作不会输入密码、验证码、密钥等敏感信息，请自行完成这一步" };
    parameters.push({ id: item.id, role: item.role, label, value: text });
  }
  const successCheck = singleLine(root.successCheck, LIMITS.maxSuccessCheckChars);
  if (!successCheck) return fail("完成标准缺失或过长");
  let irreversible = null;
  if (root.irreversible !== undefined && root.irreversible !== null) {
    const item = record(root.irreversible);
    if (!item || !IRREVERSIBLE_KINDS.includes(item.kind)) return fail("不可逆操作类型不正确");
    const summary = singleLine(item.summary, LIMITS.maxSummaryChars);
    if (!summary) return fail("不可逆操作说明缺失或过长");
    const values = new Set(parameters.map((parameter) => parameter.value));
    const bound = (field) => {
      if (field === undefined || field === null || field === "") return undefined;
      const text = literal(field, LIMITS.maxParameterChars);
      return text && values.has(text) ? text : null;
    };
    const recipient = bound(item.recipient);
    const content = bound(item.content);
    if (recipient === null || content === null) return fail("不可逆操作的对象或内容必须与任务参数完全一致");
    if (item.kind === "send_message" && (!recipient || !content)) return fail("发送消息必须写明接收人和消息内容");
    irreversible = { kind: item.kind, summary, ...(recipient ? { recipient } : {}), ...(content ? { content } : {}) };
  }
  if (!Array.isArray(root.actionKinds) || !root.actionKinds.length) return fail("允许的动作类型缺失");
  const actionKinds = [];
  for (const kind of root.actionKinds) {
    if (!ACTION_KINDS.includes(kind)) return fail("允许的动作类型不正确");
    if (!actionKinds.includes(kind)) actionKinds.push(kind);
  }
  if (!actionKinds.includes("activate_app")) actionKinds.unshift("activate_app");
  const allowed = actionKinds.filter((kind) => kind !== "type" || parameters.length > 0);
  return { ok: true, task: { goal, apps, parameters, successCheck, irreversible, actionKinds: allowed } };
}

function validateLimits(value) {
  const item = record(value);
  if (!item) return null;
  const { maxSteps, maxMinutes, minConfidence } = item;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > LIMITS.maxStepsCeiling) return null;
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > LIMITS.maxMinutesCeiling) return null;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0.3 || minConfidence > 0.95) return null;
  return { maxSteps, maxMinutes, minConfidence };
}

/* ------------------------------------------------------------------ */
/* Screen text helpers.                                                */
/* ------------------------------------------------------------------ */

function clean(value, max = 160) {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, max).join("");
}
/** Screen text quoted inside a description: bounded, no double quotes. */
function quote(value) {
  const text = clean(value, LIMITS.quoteChars).replace(/"/g, "'");
  return [...clean(value, 400)].length > LIMITS.quoteChars ? `${text}…` : text;
}
function normalizeName(value) {
  return clean(value, 200).replace(/\s*[（(]\d+[)）]$/u, "").trim();
}
function roleKey(role) {
  return String(role || "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}
function shortRole(role) {
  const raw = clean(role, 40);
  const stripped = raw.replace(/^AX/, "");
  return stripped.replace(/([a-z])([A-Z])/g, "$1_$2").toLocaleLowerCase("en-US") || "unknown";
}

const EDITABLE_ROLES = new Set(["axtextfield", "axtextarea", "axsearchfield", "axcombobox", "axsecuretextfield", "edit", "editcontrol", "textbox", "textfield", "textarea", "searchfield", "searchbox", "securetextfield"]);
const SECURE_ROLES = new Set(["axsecuretextfield", "securetextfield", "password", "passwordbox"]);
const CLICKABLE_ROLES = new Set(["axbutton", "axlink", "axmenuitem", "axmenubutton", "axpopupbutton", "axcheckbox", "axradiobutton", "axcell", "axrow", "axstatictext", "axdisclosuretriangle", "axtab", "axtabgroup", "axcolumn", "axgroup", "axincrementor", "axlistitem", "button", "hyperlink", "link", "listitem", "menuitem", "tabitem", "treeitem", "dataitem", "text", "checkbox", "radiobutton", "splitbutton"]);
const SCROLLABLE_ROLES = new Set(["axscrollarea", "axlist", "axtable", "axoutline", "axbrowser", "list", "table", "tree", "datagrid"]);
const SEARCH_WORDS = /(?:搜索|查找|筛选|search|find|filter)/iu;
const MESSAGE_WORDS = /(?:输入|消息|聊天|回复|message|chat|reply|compose|type a|写点什么)/iu;
const SEND_LABEL = /^(?:发送|发 送|发送\s*\(s\)|send|发布|发表|post|publish|提交|submit|确认发送)$/iu;
const CONFIRM_LABEL = /^(?:确定|确认|好|好的|ok|confirm|是|yes|继续|continue)$/iu;
const GRANT_LABEL = /(?:允许|授权|同意|信任|allow|authori[sz]e|agree|trust)/iu;
const DELETE_LABEL = /(?:删除|移除|清空|撤回|丢弃|移到废纸篓|废纸篓|delete|remove|clear all|trash|discard|recall)/iu;
const PAYMENT_LABEL = /(?:支付|付款|转账|购买|下单|结算|充值|红包|收款|pay\b|buy\b|checkout|purchase|transfer|top\s*up)/iu;
const OTHER_IRREVERSIBLE = /(?:退出登录|注销|卸载|格式化|抹掉|恢复出厂|关闭账户|log\s*out|sign\s*out|uninstall|erase|factory reset|delete account)/iu;

function labelRisk(text) {
  const value = clean(text, 80);
  if (!value) return "none";
  if (PAYMENT_LABEL.test(value)) return "payment";
  if (DELETE_LABEL.test(value)) return "delete";
  if (OTHER_IRREVERSIBLE.test(value) || GRANT_LABEL.test(value)) return "irreversible";
  if (SEND_LABEL.test(value) || (/(?:发送|\bsend\b)/iu.test(value) && [...value].length <= 8)) return "send";
  if (CONFIRM_LABEL.test(value)) return "submit";
  return "none";
}

/**
 * Tolerant extraction of visible text from Cua Driver's tree markdown.
 * Only quoted strings are taken; they remain untrusted observation data.
 */
function extractTreeTexts(markdown, limit = 120) {
  if (typeof markdown !== "string" || !markdown) return [];
  const texts = [];
  const seen = new Set();
  for (const lineText of markdown.split("\n")) {
    for (const match of lineText.matchAll(/"([^"\n]{1,400})"/g)) {
      const text = clean(match[1], LIMITS.maxObservationTextChars);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
      if (texts.length >= limit) return texts;
    }
  }
  return texts;
}

/* ------------------------------------------------------------------ */
/* Observation model.                                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn a normalized Cua Driver window state into the policy's element model.
 * `refs` are sequential, capture-local handles (e1, e2, …) shown to Jev.
 */
function modelElements(elements, windowBounds) {
  const model = [];
  for (const raw of Array.isArray(elements) ? elements : []) {
    if (!raw || typeof raw !== "object") continue;
    const key = roleKey(raw.role);
    const label = clean(raw.label, 120);
    const value = clean(raw.value, 160);
    const description = clean(raw.valueDescription, 120);
    const secure = SECURE_ROLES.has(key) || SECRET.test(label) || SECRET.test(description);
    const editable = EDITABLE_ROLES.has(key);
    const searchLike = editable && !secure && (key === "axsearchfield" || key === "searchfield" || key === "searchbox" || SEARCH_WORDS.test(label) || SEARCH_WORDS.test(description));
    const frame = raw.frame && [raw.frame.x, raw.frame.y, raw.frame.width, raw.frame.height].every(Number.isFinite) && raw.frame.width > 0 && raw.frame.height > 0 ? raw.frame : null;
    const lowerHalf = Boolean(frame && windowBounds && frame.y + frame.height / 2 > windowBounds.y + windowBounds.height * 0.55);
    const messageLike = editable && !secure && !searchLike && (MESSAGE_WORDS.test(label) || MESSAGE_WORDS.test(description) || lowerHalf || key === "axtextarea");
    const hasPress = Array.isArray(raw.actions) && raw.actions.some((action) => /press|click|invoke|pick|confirm/i.test(String(action)));
    model.push({
      ref: `e${model.length + 1}`,
      token: typeof raw.elementToken === "string" ? raw.elementToken : null,
      role: clean(raw.role, 60),
      roleShort: shortRole(raw.role),
      roleKey: key,
      label, value, description,
      text: label || value,
      enabled: raw.enabled !== false,
      selected: raw.selected === true,
      editable, secure, searchLike, messageLike,
      clickable: CLICKABLE_ROLES.has(key) || hasPress,
      scrollable: SCROLLABLE_ROLES.has(key),
      frame,
      identity: JSON.stringify([key, label, value, raw.depth, raw.parentIndex ?? null, raw.elementIndex ?? null]),
    });
    if (model.length >= 400) break;
  }
  return model;
}

function parameterMatch(text, parameters) {
  const value = normalizeName(text);
  if (!value) return null;
  for (const parameter of parameters) if (normalizeName(parameter.value) === value) return { parameter, exact: true };
  for (const parameter of parameters) if ([...parameter.value].length >= 2 && value.includes(parameter.value)) return { parameter, exact: false };
  return null;
}

function relevance(element, task) {
  let score = 0;
  const match = parameterMatch(element.text, task.parameters);
  if (match) score += match.exact ? (match.parameter.role === "recipient" ? 120 : 100) : 60;
  const risk = labelRisk(element.text);
  if (risk === "send" && task.irreversible && ["send_message", "submit"].includes(task.irreversible.kind)) score += 50;
  if (element.editable && !element.secure) score += 40;
  if (/^(?:axbutton|button|axlink|link|hyperlink|axmenuitem|menuitem|axtab|tabitem)$/.test(element.roleKey)) score += 20;
  else if (/^(?:axcell|axrow|axstatictext|listitem|treeitem|dataitem|text|axlistitem)$/.test(element.roleKey)) score += 15;
  if (element.selected) score += 5;
  if (!element.text) score -= 50;
  if (!element.enabled) score -= 80;
  return score;
}

/** Bounded Jev-facing projection. Screen strings stay data. */
function projectObservation({ app, windowTitle, elements, treeTexts, axSparse, task }) {
  const ranked = elements
    .map((element) => ({ element, score: relevance(element, task) }))
    .filter(({ element }) => element.text || element.editable)
    .sort((a, b) => b.score - a.score || Number(a.element.ref.slice(1)) - Number(b.element.ref.slice(1)))
    .slice(0, LIMITS.maxObservationElements)
    .map(({ element }) => element)
    .sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
  const labels = new Set(ranked.map((element) => element.text));
  const params = task.parameters.map((parameter) => parameter.value);
  const texts = treeTexts
    .filter((text) => !labels.has(text))
    .map((text, index) => ({ text, index, score: params.some((value) => text.includes(value)) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, LIMITS.maxObservationTexts)
    .sort((a, b) => a.index - b.index)
    .map(({ text }) => text);
  return {
    trust: "untrusted_screen_content",
    app: clean(app, 60) || null,
    windowTitle: clean(windowTitle, 160) || null,
    axSparse: Boolean(axSparse),
    elementsTotal: elements.length,
    elements: ranked.map((element) => ({
      ref: element.ref, role: element.roleShort,
      ...(element.label ? { label: clean(element.label, 120) } : {}),
      ...(element.value && !element.secure ? { value: clean(element.value, 160) } : {}),
      ...(element.editable ? { editable: true } : {}), ...(element.secure ? { secure: true } : {}),
      ...(element.selected ? { selected: true } : {}), ...(!element.enabled ? { disabled: true } : {}),
      ...(element.searchLike ? { searchBox: true } : {}), ...(element.messageLike ? { messageBox: true } : {}),
    })),
    texts,
  };
}

/* ------------------------------------------------------------------ */
/* Tracker (application-owned state about focus, drafts, navigation).  */
/* ------------------------------------------------------------------ */

function emptyTracker() {
  return Object.freeze({
    focus: "none", searchText: null, composerText: null, conversationTarget: null,
    sendCount: 0, irreversibleCounts: Object.freeze({}), typed: Object.freeze([]),
    delivery: "background", backgroundSuspect: false,
    sendBaseline: null,
  });
}

function recipientOf(task) {
  return task.irreversible && task.irreversible.recipient
    ? task.irreversible.recipient
    : (task.parameters.find((parameter) => parameter.role === "recipient") || {}).value || null;
}

/* ------------------------------------------------------------------ */
/* Candidates.                                                         */
/* ------------------------------------------------------------------ */

function candidateDescriptions(appName) {
  return {
    reobserve: { description: "Do not act now; take a fresh observation because the screen may still be loading or changing.", label: "重新读取界面" },
    abstain: { description: "Stop without acting because no listed action is safe and useful for the task in the current state, or the user must handle the screen.", label: "停止，不再操作" },
    done: { description: `Stop because the observation of "${quote(appName)}" already shows the task's success check is satisfied.`, label: "任务已完成" },
  };
}

function freezeCandidate(candidate) {
  return Object.freeze({ ...candidate, ...(candidate.point ? { point: Object.freeze({ ...candidate.point }) } : {}), ...(candidate.keys ? { keys: Object.freeze([...candidate.keys]) } : {}) });
}

function sendClause(task) {
  const irreversible = task.irreversible;
  if (!irreversible || irreversible.kind !== "send_message") return "";
  return ` This SENDS a message. Choose it only if the open conversation is with "${quote(irreversible.recipient)}" and the message input contains exactly "${quote(irreversible.content)}".`;
}

/**
 * Build the closed, immutable candidate table for one capture.
 * `context`: { platform, task, grantApps, target: { app, pid, windowId, title, running, minimized } | null,
 *   elements (modelElements), axSparse, screenshot: { width, height, frameValid } | null, windowBounds,
 *   tracker, canLaunch }
 */
function buildCandidates(context) {
  const { task, tracker, target } = context;
  const appName = target ? target.app : (task.apps[0] && task.apps[0].name) || "app";
  const kinds = new Set(task.actionKinds);
  const out = [];
  const add = (candidate) => { if (!out.some((item) => item.id === candidate.id)) out.push(candidate); };
  const keyMod = context.platform === "win32" ? "ctrl" : "cmd";
  const keyModLabel = context.platform === "win32" ? "Ctrl+F" : "⌘F";
  const fg = tracker.delivery === "foreground";
  const deliverySuffix = fg ? ` Uses foreground delivery: "${quote(appName)}" is brought to the front briefly because background input was refused or had no effect.` : "";
  const deliveryLabel = fg ? "（前台）" : "";
  const idSuffix = fg ? "_fg" : "";
  const recipient = recipientOf(task);

  // 1. Activate / launch granted apps.
  if (kinds.has("activate_app")) {
    (context.appStates || []).forEach((state, index) => {
      if (target && state.name === target.app && state.running && target.windowId && !target.minimized) return;
      if (!state.running && !context.canLaunch) return;
      const verb = !state.running ? "launch" : state.hasWindow ? "switch" : "front";
      add({
        id: `app_${index + 1}`, kind: "activate_app", risk: "none", appIndex: index, launch: verb,
        description: verb === "launch"
          ? `Open the app "${quote(state.name)}" (launch it in the background) and make its main window the target.`
          : verb === "switch" ? `Switch the target to the app "${quote(state.name)}" and observe its main window.`
            : `Bring the "${quote(state.name)}" window to the front because it is minimized or has no visible window.`,
        label: verb === "launch" ? `打开「${quote(state.name)}」` : verb === "switch" ? `切换到「${quote(state.name)}」` : `把「${quote(state.name)}」窗口切到前台`,
        expect: `A main window of "${quote(state.name)}" is available.`,
      });
    });
  }
  if (!target || !target.windowId) {
    return finish(out, appName);
  }
  const elements = context.elements || [];
  const secureVisible = elements.some((element) => element.secure);
  const typedAlready = (field, text) => tracker.typed.some((entry) => entry.field === field && entry.text === text);

  // 2. Keyboard allowlist (window-targeted).
  if (kinds.has("key")) {
    add({ id: `open_search${idSuffix}`, kind: "hotkey", risk: "none", keys: [keyMod, "f"], delivery: tracker.delivery, focusAfter: "search",
      description: `Press ${context.platform === "win32" ? "Ctrl+F" : "Command+F"} in the "${quote(appName)}" window to put keyboard focus in its search box.${deliverySuffix}`,
      label: `按 ${keyModLabel} 打开搜索${deliveryLabel}`, expect: `A search box in the "${quote(appName)}" window has keyboard focus.` });
    let returnRisk = "submit", returnDescription, returnLabel, returnExpect;
    // Return is harmless only while a search box visibly holds this run's
    // search text. Otherwise keyboard focus is uncertain and Return could
    // send a draft, so it stays a risky submit.
    const searchConfirmed = tracker.focus === "search" && Boolean(tracker.searchText) &&
      elements.some((element) => element.searchLike && normalizeName(element.value) === normalizeName(tracker.searchText));
    if (searchConfirmed) {
      returnRisk = "none";
      returnDescription = `Press Return to open the highlighted search result${tracker.searchText ? ` for "${quote(tracker.searchText)}"` : ""}.`;
      returnLabel = `按回车打开搜索结果${tracker.searchText ? `「${quote(tracker.searchText)}」` : ""}`;
      returnExpect = tracker.searchText ? `The conversation or item "${quote(tracker.searchText)}" is open.` : "The highlighted search result is open.";
    } else if ((tracker.focus === "conversation" || tracker.focus === "field") && tracker.composerText) {
      returnRisk = task.irreversible && task.irreversible.kind === "submit" ? "submit" : "send";
      returnDescription = `Press Return to send or submit the text in the focused input box.${sendClause(task)}`;
      returnLabel = `按回车发送「${quote(tracker.composerText)}」`;
      returnExpect = `"${quote(tracker.composerText)}" appears as a sent message and the input box is empty.`;
    } else {
      returnDescription = `Press Return in the "${quote(appName)}" window. If a text box, list or dialog has focus this may open, submit or send it.`;
      returnLabel = "按回车";
      returnExpect = "The focused item is opened or submitted.";
    }
    add({ id: `key_return${idSuffix}`, kind: "key", key: "return", risk: returnRisk, delivery: tracker.delivery, description: `${returnDescription}${deliverySuffix}`, label: `${returnLabel}${deliveryLabel}`, expect: returnExpect });
    add({ id: "key_escape", kind: "key", key: "escape", risk: "none", delivery: tracker.delivery, description: "Press Escape to close the current menu, popover, dialog or search.", label: "按 Esc 关闭弹出内容", expect: "The menu, dialog or search is closed.", focusAfter: "none" });
    add({ id: "key_tab", kind: "key", key: "tab", risk: "none", delivery: tracker.delivery, description: "Press Tab to move keyboard focus to the next control.", label: "按 Tab 切换焦点", expect: "Keyboard focus moved to the next control." });
    add({ id: "key_down", kind: "key", key: "down", risk: "none", delivery: tracker.delivery, description: "Press the Down arrow key to move the selection down, for example to the next search result.", label: "按 ↓ 选择下一项", expect: "The selection moved down by one item." });
    add({ id: "key_up", kind: "key", key: "up", risk: "none", delivery: tracker.delivery, description: "Press the Up arrow key to move the selection up.", label: "按 ↑ 选择上一项", expect: "The selection moved up by one item." });
    if (tracker.focus !== "none" && (tracker.searchText || tracker.composerText)) {
      add({ id: "key_backspace", kind: "key", key: "backspace", risk: "none", delivery: tracker.delivery, description: "Press Backspace once to delete the character before the cursor in the focused input box.", label: "按退格删除一个字", expect: "One character was removed from the focused input." });
    }
  }

  // 3. Type task literals: into the focused input (keyboard path) and into editable elements.
  if (kinds.has("type")) {
    const focusField = tracker.focus === "search" ? "search" : tracker.focus === "conversation" ? "message" : tracker.focus === "field" ? "field" : null;
    if (focusField && !secureVisible) {
      for (const parameter of task.parameters) {
        const fits = focusField === "search" ? parameter.role !== "message" : focusField === "message" ? parameter.role === "message" || parameter.role === "text" : true;
        if (!fits || typedAlready(`focus:${focusField}`, parameter.value)) continue;
        add({ id: `type_${parameter.id}_focus${idSuffix}`, kind: "type", risk: "none", text: parameter.value, parameterId: parameter.id, parameterRole: parameter.role, field: focusField, delivery: tracker.delivery,
          description: `Type the literal text "${quote(parameter.value)}" (${quote(parameter.label)}) into the ${focusField === "search" ? "search box" : focusField === "message" ? "message input box of the open conversation" : "input box"} that currently has keyboard focus.${deliverySuffix}`,
          label: `在${focusField === "search" ? "搜索框" : focusField === "message" ? "消息输入框" : "输入框"}输入「${quote(parameter.value)}」${deliveryLabel}`,
          expect: `The ${focusField === "search" ? "search box" : "input box"} contains "${quote(parameter.value)}".` });
      }
    }
    const fields = elements.filter((element) => element.editable && !element.secure && element.enabled && element.token)
      .sort((a, b) => Number(b.searchLike) - Number(a.searchLike) || Number(b.messageLike) - Number(a.messageLike))
      .slice(0, 4);
    let typeCount = 0;
    for (const field of fields) {
      for (const parameter of task.parameters) {
        const fits = field.searchLike ? parameter.role !== "message" : field.messageLike ? parameter.role === "message" || parameter.role === "text" : true;
        if (!fits || typeCount >= 6) continue;
        if (normalizeName(field.value) === normalizeName(parameter.value) || typedAlready(field.identity, parameter.value)) continue;
        const where = field.label ? `the ${field.searchLike ? "search box" : "text field"} labelled "${quote(field.label)}"` : field.messageLike ? "the unlabelled text area near the bottom of the window (likely the message input box)" : `the unlabelled ${field.roleShort}`;
        add({ id: `type_${parameter.id}_${field.ref}`, kind: "type", risk: "none", text: parameter.value, parameterId: parameter.id, parameterRole: parameter.role,
          field: field.searchLike ? "search" : field.messageLike ? "message" : "field", elementToken: field.token, elementIdentity: field.identity, elementRef: field.ref, delivery: "background",
          description: `Type the literal text "${quote(parameter.value)}" (${quote(parameter.label)}) into ${where}${field.value ? ` which currently contains "${quote(field.value)}"` : ""}.`,
          label: `在${field.searchLike ? "搜索框" : field.messageLike ? "消息输入框" : "输入框"}${field.label ? `「${quote(field.label)}」` : ""}输入「${quote(parameter.value)}」`,
          expect: `The field contains "${quote(parameter.value)}".` });
        typeCount += 1;
      }
    }
  }

  // 4. Click actionable elements (relevance ranked).
  const reserved = RESERVED.length;
  const room = () => LIMITS.maxCandidates - reserved - out.length;
  if (kinds.has("click")) {
    const clickable = elements
      .filter((element) => element.token && element.enabled && element.clickable && !element.secure && (element.text || element.editable))
      .map((element) => ({ element, score: relevance(element, task) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, Math.min(16, room() - 2)));
    for (const { element } of clickable) {
      const risk = element.editable ? "none" : labelRisk(element.text);
      const matchesRecipient = Boolean(recipient && normalizeName(element.text) === normalizeName(recipient));
      add({ id: `click_${element.ref}`, kind: "click", risk, elementToken: element.token, elementIdentity: element.identity, elementRef: element.ref, delivery: "background",
        editable: element.editable, searchLike: element.searchLike, messageLike: element.messageLike, matchesRecipient, clickedText: element.text,
        description: `Click the ${element.roleShort} "${quote(element.text || element.roleShort)}"${element.selected ? " (currently selected)" : ""}.${risk === "send" ? sendClause(task) : risk !== "none" ? " This may be an irreversible action." : ""}`,
        label: `点击「${quote(element.text || element.roleShort)}」`,
        expect: element.editable ? `The field "${quote(element.text || element.roleShort)}" has keyboard focus.` : matchesRecipient ? `The conversation with "${quote(recipient)}" is open.` : `The "${quote(element.text)}" control reacted.` });
    }
  }

  // 5. Coordinate fallback when the accessibility tree is sparse.
  const shot = context.screenshot;
  if (kinds.has("click") && context.axSparse && shot && shot.frameValid && context.windowBounds && context.windowBounds.width > 0) {
    const scale = shot.width / context.windowBounds.width;
    const points = elements
      .filter((element) => !element.token && element.frame && element.text && !element.secure && (parameterMatch(element.text, task.parameters) || labelRisk(element.text) === "send"))
      .slice(0, 4);
    for (const element of points) {
      const localX = element.frame.x - context.windowBounds.x + element.frame.width / 2;
      const localY = element.frame.y - context.windowBounds.y + element.frame.height / 2;
      const x = Math.round(localX * scale), y = Math.round(localY * scale);
      if (!(x >= 0 && y >= 0 && x < shot.width && y < shot.height)) continue;
      const risk = labelRisk(element.text);
      const matchesRecipient = Boolean(recipient && normalizeName(element.text) === normalizeName(recipient));
      add({ id: `point_${element.ref}`, kind: "point", risk, point: { x, y }, elementRef: element.ref, delivery: tracker.delivery, matchesRecipient, clickedText: element.text,
        description: `Click at the screen position of the text "${quote(element.text)}" (it exposes no accessibility action, so the click uses window coordinates).${risk === "send" ? sendClause(task) : ""}${deliverySuffix}`,
        label: `点击文字「${quote(element.text)}」所在位置${deliveryLabel}`,
        expect: matchesRecipient ? `The conversation with "${quote(recipient)}" is open.` : `The "${quote(element.text)}" item reacted.` });
    }
  }

  // 6. Scroll the largest list.
  if (kinds.has("scroll") && room() > 1) {
    const list = elements.filter((element) => element.scrollable && element.token && element.enabled)
      .sort((a, b) => (b.frame ? b.frame.width * b.frame.height : 0) - (a.frame ? a.frame.width * a.frame.height : 0))[0];
    if (list) {
      for (const direction of ["down", "up"]) {
        add({ id: `scroll_${direction}_${list.ref}`, kind: "scroll", risk: "none", direction, elementToken: list.token, elementIdentity: list.identity, elementRef: list.ref, delivery: "background",
          description: `Scroll the ${list.roleShort}${list.text ? ` "${quote(list.text)}"` : ""} ${direction} to reveal more items.`,
          label: `向${direction === "down" ? "下" : "上"}滚动列表`, expect: "Different items are visible in the list." });
      }
    }
  }
  return finish(out, appName);
}

function finish(out, appName) {
  const reserved = candidateDescriptions(appName);
  const executable = out.slice(0, LIMITS.maxCandidates - RESERVED.length);
  const all = [
    ...executable,
    ...RESERVED.map((id) => ({ id, kind: "reserved", risk: "none", description: reserved[id].description, label: reserved[id].label })),
  ].map((candidate) => ({ ...candidate, description: [...candidate.description].slice(0, LIMITS.maxDescriptionChars).join("") }));
  return Object.freeze(all.map(freezeCandidate));
}

function publicCandidate(candidate) {
  return { id: candidate.id, kind: candidate.kind, description: candidate.description, label: candidate.label, risk: candidate.risk, ...(candidate.expect ? { expect: candidate.expect } : {}) };
}

/* ------------------------------------------------------------------ */
/* Authorization and scope.                                            */
/* ------------------------------------------------------------------ */

function occurrences(texts, content) {
  const target = normalizeName(content);
  if (!target) return 0;
  return texts.filter((text) => normalizeName(text) === target).length;
}

/**
 * Visible copies of a sent text, counted over non-editable elements only: the
 * tree markdown renders the same elements (double counting) and an input box
 * holding the draft is not a sent message.
 */
function sentTextCount(elements, content) {
  return occurrences(elements.filter((element) => !element.editable).map((element) => element.text), content);
}

/**
 * Evidence that a send reaches the granted recipient with the granted text.
 * All three must hold: the recipient is visible, the conversation was opened
 * by this run for that recipient (or the window title names it), and the
 * message input holds exactly the granted content.
 */
function sendEvidence({ task, tracker, observation }) {
  const irreversible = task.irreversible;
  if (!irreversible || !irreversible.recipient || !irreversible.content) return { ok: false, reason: "未授予发送消息" };
  const recipient = normalizeName(irreversible.recipient);
  const content = normalizeName(irreversible.content);
  const texts = [observation.windowTitle || "", ...observation.elements.filter((element) => !element.editable).map((element) => element.text), ...observation.treeTexts];
  const recipientVisible = texts.some((text) => normalizeName(text) === recipient);
  const provenance = tracker.conversationTarget !== null && normalizeName(tracker.conversationTarget) === recipient
    || normalizeName(observation.windowTitle || "") === recipient;
  const inputs = observation.elements.filter((element) => element.editable && !element.searchLike);
  const inputHolds = inputs.some((element) => normalizeName(element.value) === content)
    || (inputs.every((element) => !element.value) && tracker.composerText !== null && normalizeName(tracker.composerText) === content && (tracker.focus === "conversation" || tracker.focus === "field"));
  if (!recipientVisible) return { ok: false, reason: `界面上没有看到联系人「${irreversible.recipient}」` };
  if (!provenance) return { ok: false, reason: `无法确认当前聊天是本次为「${irreversible.recipient}」打开的` };
  if (!inputHolds) return { ok: false, reason: `无法确认输入框里恰好是「${irreversible.content}」` };
  return { ok: true };
}

const RISK_LABELS = { send: "发送", submit: "提交/确认", delete: "删除", payment: "付款", irreversible: "不可逆操作" };
// A granted send covers only send-type candidates (a 发送/Send control or
// Return in the message composer), never a generic 确定/OK confirmation.
const GRANT_KIND_FOR_RISK = { send: ["send_message"], submit: ["submit"], delete: ["delete"], payment: ["payment"], irreversible: ["other"] };

/**
 * Authorization against the consent grant. Returns
 *   { allowed: true } | { allowed: false, extraConsent: {...} } | { allowed: false, reason }.
 * `extraConsent` means the action is outside the grant (or cannot be verified)
 * and may run only after a new, explicit native confirmation.
 */
function authorizeCandidate(candidate, { task, tracker, observation, grantApps }) {
  if (!candidate || candidate.kind === "reserved") return { allowed: false, reason: "保留选项不执行动作" };
  const kind = candidate.kind === "hotkey" ? "key" : candidate.kind === "point" ? "click" : candidate.kind;
  if (!task.actionKinds.includes(kind)) return { allowed: false, reason: "动作类型不在本次授权范围内" };
  if (candidate.kind === "activate_app") {
    return typeof candidate.appIndex === "number" && grantApps[candidate.appIndex] ? { allowed: true } : { allowed: false, reason: "目标应用不在本次授权范围内" };
  }
  if (!observation.appAllowed) return { allowed: false, reason: "当前窗口不属于本次授权的应用" };
  if (candidate.kind === "type") {
    if (!task.parameters.some((parameter) => parameter.id === candidate.parameterId && parameter.value === candidate.text)) return { allowed: false, reason: "只能输入本次授权的文字" };
    if (candidate.elementToken && observation.elements.some((element) => element.token === candidate.elementToken && element.secure)) return { allowed: false, reason: "不会向密码或验证码输入框输入内容" };
    if (!candidate.elementToken && observation.elements.some((element) => element.secure)) return { allowed: false, reason: "界面中有密码类输入框，不向当前焦点输入" };
    if (tracker.typed.some((entry) => entry.field === (candidate.elementIdentity || `focus:${candidate.field}`) && entry.text === candidate.text)) return { allowed: false, reason: "这段文字已经输入过，不重复输入" };
    return { allowed: true };
  }
  if (candidate.risk === "none") return { allowed: true };
  const granted = task.irreversible && (GRANT_KIND_FOR_RISK[candidate.risk] || []).includes(task.irreversible.kind);
  const label = RISK_LABELS[candidate.risk] || "不可逆操作";
  if (granted) {
    const used = tracker.irreversibleCounts[candidate.risk] || 0;
    if (candidate.risk === "send") {
      if (tracker.sendCount > 0) return { allowed: false, reason: "本次授权的发送已经执行过，不会重复发送" };
      const evidence = sendEvidence({ task, tracker, observation });
      if (evidence.ok) return { allowed: true };
      return { allowed: false, extraConsent: { risk: candidate.risk, summary: `${task.irreversible.summary}`, reason: `${evidence.reason}，无法自动核实发送对象和内容` } };
    }
    if (used > 0) return { allowed: false, reason: `本次授权的${label}已经执行过，不会重复执行` };
    return { allowed: true };
  }
  return { allowed: false, extraConsent: { risk: candidate.risk, summary: `${label}：${candidate.label}`, reason: `这一步是「${label}」，不在本次授权范围内` } };
}

/**
 * Application-owned state transition after an executed action.
 * An irreversible candidate counts as attempted whenever input may have been
 * delivered (delivered, unverified, no visible effect or unknown); only a
 * clean refusal ("failed") leaves it available. It is never replayed.
 */
function nextTracker(tracker, candidate, status, { task }) {
  const landed = status === "delivered" || status === "unverified";
  const next = { ...tracker, typed: [...tracker.typed], irreversibleCounts: { ...tracker.irreversibleCounts } };
  if ((status === "failed" || status === "no_effect") && candidate.delivery === "background" && ["key", "hotkey", "type", "point"].includes(candidate.kind)) next.delivery = "foreground";
  if (candidate.risk && candidate.risk !== "none" && candidate.kind !== "reserved" && ["delivered", "unverified", "no_effect", "unknown"].includes(status)) {
    next.irreversibleCounts[candidate.risk] = (next.irreversibleCounts[candidate.risk] || 0) + 1;
    if (candidate.risk === "send") next.sendCount += 1;
    if (landed) {
      Object.assign(next, { composerText: null, typed: next.typed.filter((entry) => !entry.field.startsWith("focus:message") && !entry.field.startsWith("focus:field")) });
    }
    return Object.freeze(next);
  }
  if (!landed) return Object.freeze(next);
  const recipient = recipientOf(task);
  switch (candidate.kind) {
    case "activate_app":
      Object.assign(next, { focus: "none", searchText: null, composerText: null, conversationTarget: null, delivery: "background" });
      break;
    case "hotkey":
      // Re-opening search allows the search literal to be typed again.
      Object.assign(next, { focus: "search", searchText: null, typed: next.typed.filter((entry) => entry.field !== "focus:search") });
      break;
    case "type": {
      next.typed.push({ field: candidate.elementIdentity || `focus:${candidate.field}`, text: candidate.text });
      if (candidate.field === "search") Object.assign(next, { focus: "search", searchText: candidate.text });
      else if (candidate.field === "message") Object.assign(next, { focus: tracker.focus === "field" ? "field" : "conversation", composerText: candidate.text });
      else Object.assign(next, { focus: "field", composerText: candidate.text });
      break;
    }
    case "key":
      if (candidate.key === "return") {
        if (tracker.focus === "search" && candidate.risk === "none") {
          const opened = tracker.searchText && recipient && normalizeName(tracker.searchText) === normalizeName(recipient) ? tracker.searchText : null;
          Object.assign(next, { focus: "conversation", conversationTarget: opened, composerText: null, searchText: null, typed: next.typed.filter((entry) => !entry.field.startsWith("focus:")) });
        }
      } else if (candidate.key === "escape") {
        Object.assign(next, { focus: tracker.focus === "search" ? "none" : tracker.focus, searchText: null });
      } else if (candidate.key === "backspace") {
        next.typed = next.typed.filter((entry) => !entry.field.startsWith("focus:"));
      }
      break;
    case "click":
    case "point":
      if (candidate.editable) {
        Object.assign(next, { focus: candidate.searchLike ? "search" : candidate.messageLike ? (tracker.conversationTarget ? "conversation" : "field") : "field" });
      } else if (candidate.matchesRecipient) {
        Object.assign(next, { focus: "conversation", conversationTarget: recipient, composerText: null, searchText: null });
      } else {
        Object.assign(next, { focus: "none", conversationTarget: null, composerText: null, searchText: null });
      }
      break;
    default:
      break;
  }
  if (status === "delivered" && candidate.delivery === "foreground") next.delivery = "foreground";
  return Object.freeze(next);
}

function facts({ tracker, task, observation, sendBaseline, appName, appRunning }) {
  const content = task.irreversible && task.irreversible.content;
  let sendEvidenceFacts;
  if (tracker.sendCount > 0 && content && sendBaseline !== null && observation) {
    const inputs = observation.elements.filter((element) => element.editable && !element.searchLike);
    sendEvidenceFacts = {
      before: sendBaseline,
      after: sentTextCount(observation.elements, content),
      inputStillHasText: inputs.length ? inputs.some((element) => normalizeName(element.value).includes(normalizeName(content))) : null,
    };
  }
  return {
    focus: tracker.focus,
    ...(tracker.searchText ? { typedIntoSearch: tracker.searchText } : {}),
    ...(tracker.composerText ? { typedIntoMessageBox: tracker.composerText } : {}),
    ...(tracker.conversationTarget ? { conversationOpenedFor: tracker.conversationTarget } : {}),
    irreversibleDone: tracker.sendCount > 0 || Object.values(tracker.irreversibleCounts).some((count) => count > 0),
    ...(sendEvidenceFacts ? { sendEvidence: sendEvidenceFacts } : {}),
    ...(appName ? { targetApp: appName } : {}),
    appRunning: Boolean(appRunning),
  };
}

/* ------------------------------------------------------------------ */
/* Consent text (one native dialog).                                   */
/* ------------------------------------------------------------------ */

const KIND_LABELS = { activate_app: "打开或切换应用", click: "点击界面元素", type: "输入下列文字", key: "按键（⌘F、回车、Esc、Tab、方向键、退格）", scroll: "滚动列表" };

function consentDialog(task, limits, { platform, missingPermissions, screenRecordingSkipped = false }) {
  const apps = task.apps.map((app) => `「${app.name}」`).join("、");
  const kinds = task.actionKinds.map((kind) => platform === "win32" ? KIND_LABELS[kind].replace("⌘F", "Ctrl+F") : KIND_LABELS[kind]).join("、");
  const lines = [
    "本次授权（只对这一个任务有效）：",
    `· 目标应用：${apps}`,
    `· 允许的动作：${kinds}`,
    task.parameters.length ? `· 只会输入这些文字：${task.parameters.map((parameter) => `「${parameter.value}」`).join("、")}` : "· 不会输入任何文字",
    task.irreversible ? `· 不可逆操作（最多一次）：${task.irreversible.summary}` : "· 不会发送、提交、删除或付款",
    `· 上限：最多 ${limits.maxSteps} 步、${limits.maxMinutes} 分钟；随时可以点同频里的「停止」或按 Esc 立即停止`,
    "· 执行时目标应用可能会被短暂切到前台",
  ];
  if (platform === "darwin") {
    const names = { accessibility: "辅助功能", screenRecording: "屏幕录制" };
    lines.push(missingPermissions.length
      ? `· 需要的系统权限：${missingPermissions.map((item) => names[item]).join("、")}（点“允许并开始”后系统会一并申请，未开启时会打开对应的系统设置页面）`
      : screenRecordingSkipped
        ? "· 系统权限：辅助功能已开启；屏幕录制未开启，本次只读取界面结构，不使用截图坐标"
        : "· 系统权限：辅助功能、屏幕录制已开启");
  }
  lines.push("", "同频会读取目标应用窗口的界面结构，由 Jev 决策服务逐步选择下一步（不上传截图）。删除、付款等未写在上面的不可逆操作会先停下来再次询问你。");
  return {
    title: "允许同频 AI 操作你的电脑？",
    message: `同频 AI 将使用${apps}完成：${task.goal}`,
    detail: lines.join("\n"),
    buttons: ["取消", "允许并开始"],
  };
}

function extraConsentDialog(candidate, extra) {
  return {
    title: "需要你再次确认",
    message: `下一步将${candidate.label}。${extra.reason}。是否仅允许这一次？`,
    detail: `${extra.summary ? `涉及：${extra.summary}\n` : ""}窗口里的文字来自目标应用，请先核对界面。选择“停止任务”将立即结束本次电脑操作。`,
    buttons: ["停止任务", "仅允许这一次"],
  };
}

module.exports = {
  LIMITS,
  RESERVED,
  authorizeCandidate,
  buildCandidates,
  consentDialog,
  emptyTracker,
  extraConsentDialog,
  extractTreeTexts,
  facts,
  labelRisk,
  modelElements,
  nextTracker,
  normalizeName,
  occurrences,
  projectObservation,
  publicCandidate,
  sendEvidence,
  sentTextCount,
  validateLimits,
  validateTaskSpec,
};
