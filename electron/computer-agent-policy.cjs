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
 * `refs` are sequential, capture-local handles (e1, e2, …) shown to Jev;
 * `refStart` continues the numbering for a second window of the same capture.
 */
function modelElements(elements, windowBounds, refStart = 0) {
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
    // messageBox: stronger evidence (named or placed like a chat composer) than
    // messageLike, which also takes any unlabelled text area.
    const messageBox = editable && !secure && !searchLike && (MESSAGE_WORDS.test(label) || MESSAGE_WORDS.test(description) || lowerHalf);
    const messageLike = messageBox || (editable && !secure && !searchLike && key === "axtextarea");
    const hasPress = Array.isArray(raw.actions) && raw.actions.some((action) => /press|click|invoke|pick|confirm/i.test(String(action)));
    model.push({
      ref: `e${refStart + model.length + 1}`,
      token: typeof raw.elementToken === "string" ? raw.elementToken : null,
      role: clean(raw.role, 60),
      roleShort: shortRole(raw.role),
      roleKey: key,
      label, value, description,
      text: label || value,
      enabled: raw.enabled !== false,
      selected: raw.selected === true,
      editable, secure, searchLike, messageLike, messageBox,
      clickable: CLICKABLE_ROLES.has(key) || hasPress,
      scrollable: SCROLLABLE_ROLES.has(key),
      frame,
      identity: JSON.stringify([key, label, value, raw.depth, raw.parentIndex ?? null, raw.elementIndex ?? null]),
    });
    if (model.length >= 1000) break;
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

/**
 * Keypad buttons for a calculation the task spells out ("计算 128×36"). All
 * keypad buttons score alike (plain buttons), so the digits, the operator and
 * "=" could fall behind the first 16 buttons in accessibility order. Seen on
 * macOS Calculator: "=" (等于) was never a candidate, so after clicking
 * 1 2 8 × 3 6 Jev could only consider Return with unknown focus and stopped
 * to ask twice. Only the ranking changes; risk and authorization do not.
 */
const ARITHMETIC_EXPRESSION = /\d\s*[+\-−＋－×xX*＊÷/／]\s*\d/u;
const KEYPAD_OPERATORS = Object.freeze([
  { symbols: /[+＋]/u, labels: /^(?:\+|＋|加|加号|plus|add)$/iu },
  { symbols: /\d\s*[-−－]/u, labels: /^(?:-|−|－|减|减号|minus|subtract)$/iu },
  { symbols: /[×xX*＊]/u, labels: /^(?:×|\*|x|乘|乘号|multiply|times)$/iu },
  { symbols: /[÷/／]/u, labels: /^(?:÷|\/|除|除号|divide)$/iu },
]);
const KEYPAD_EQUALS = /^(?:=|＝|等于|等号|equals?)$/iu;
const KEYPAD_DECIMAL = /^(?:\.|．|小数点|decimal|point)$/iu;

function keypadRelevance(element, task) {
  const label = normalizeName(element.text);
  if (!label || [...label].length > 8 || element.editable) return 0;
  const expressions = task.parameters.map((parameter) => parameter.value).filter((value) => ARITHMETIC_EXPRESSION.test(value));
  if (!expressions.length) return 0;
  if (KEYPAD_EQUALS.test(label)) return 70;
  if (/^\d$/u.test(label)) return expressions.some((value) => value.includes(label)) ? 50 : 0;
  if (KEYPAD_DECIMAL.test(label)) return expressions.some((value) => /\d[.．]\d/u.test(value)) ? 50 : 0;
  return KEYPAD_OPERATORS.some((operator) => operator.labels.test(label) && expressions.some((value) => operator.symbols.test(value))) ? 50 : 0;
}

function relevance(element, task) {
  let score = keypadRelevance(element, task);
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
    // searchMoved: ↓/↑ moved the highlighted search result after typing.
    // searchByKeys: the search text arrived as keystrokes, so keyboard focus
    // was in the search box (an accessibility write proves no focus).
    // searchSeen: the search literal the executor's landing check saw reach
    // the search box, and searchSeenBy how: "value" (the box shows it),
    // "results" (new items naming it; searchResultsBase = how many there were
    // before typing) or "list" (the list under the box appeared or redrew).
    // The proof is re-checked on every capture and before Return runs.
    focus: "none", searchText: null, searchMoved: false, searchByKeys: false, searchSeen: null, searchSeenBy: null, searchResultsBase: null, composerText: null, conversationTarget: null, conversationVia: null,
    sendCount: 0, irreversibleCounts: Object.freeze({}), typed: Object.freeze([]),
    delivery: "background", backgroundSuspect: false,
    // Element identities whose background click/type was refused or had no
    // effect. They are offered again only as distinct foreground candidates.
    refused: Object.freeze([]),
    // Text typed "into focus" was seen in the wrong kind of input box. No
    // further typing or Return is offered; the run is stopped.
    misdirected: false,
    // Cua could not prove an addressed element belongs to the window
    // (WeChat's virtual accessibility nodes): every element-addressed
    // background action would be refused the same way, so none is offered.
    elementsRefused: false,
    // The target app is known to take no background input (WeChat), or it
    // refused it in an earlier run: start, and after switching apps stay, on
    // the foreground rung instead of spending steps on background misses.
    preferForeground: false,
    sendBaseline: null,
  });
}

/** A tracker that starts on the foreground rung, without element-addressed background actions. */
function foregroundFirst(tracker) {
  return Object.freeze({ ...tracker, delivery: "foreground", elementsRefused: true, preferForeground: true });
}

/** Smallest element side (points) that a position click may target. */
const MIN_POINT_SIDE = 4;
/** Frames may overhang the window edge by this much (shadows, rounding). */
const FRAME_SLACK = 2;

function plausibleFrame(frame, bounds) {
  if (!frame || !bounds) return false;
  if (!(frame.width >= MIN_POINT_SIDE && frame.height >= MIN_POINT_SIDE)) return false;
  return frame.x >= bounds.x - FRAME_SLACK && frame.y >= bounds.y - FRAME_SLACK &&
    frame.x + frame.width <= bounds.x + bounds.width + FRAME_SLACK &&
    frame.y + frame.height <= bounds.y + bounds.height + FRAME_SLACK;
}

function recipientOf(task) {
  return task.irreversible && task.irreversible.recipient
    ? task.irreversible.recipient
    : (task.parameters.find((parameter) => parameter.role === "recipient") || {}).value || null;
}

/**
 * A click on the granted recipient's row is confirmed when that row — the one
 * under the click, not a search hit or a header elsewhere — is selected now
 * and no row with that name was selected before the click.
 */
function recipientNewlySelected(before, after, task, targetFrame) {
  const recipient = normalizeName(recipientOf(task));
  if (!recipient) return false;
  const selected = (elements) => (Array.isArray(elements) ? elements : [])
    .filter((element) => !element.editable && element.selected && normalizeName(element.text) === recipient);
  if (selected(before).length) return false;
  const now = selected(after);
  if (!targetFrame) return false;
  const cx = targetFrame.x + targetFrame.width / 2, cy = targetFrame.y + targetFrame.height / 2;
  return now.some((element) => element.frame &&
    cx >= element.frame.x && cx <= element.frame.x + element.frame.width &&
    cy >= element.frame.y && cy <= element.frame.y + element.frame.height);
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
  return Object.freeze({ ...candidate, ...(candidate.point ? { point: Object.freeze({ ...candidate.point }) } : {}), ...(candidate.targetFrame ? { targetFrame: Object.freeze({ ...candidate.targetFrame }) } : {}), ...(candidate.keys ? { keys: Object.freeze([...candidate.keys]) } : {}) });
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
  const refused = new Set(tracker.refused || []);
  const shot = context.screenshot;
  const bounds = context.windowBounds;
  const pixelMap = shot && shot.frameValid && bounds && bounds.width > 0 ? shot.width / bounds.width : null;
  /**
   * Window-screenshot pixel position of an element's centre, or null unless
   * its frame is a plausible rectangle lying wholly inside the target window:
   * virtualized rows report 1-pt or off-window frames, and a click there
   * would land on whatever occupies that point instead.
   */
  const pixelPoint = (element) => {
    if (!pixelMap || !plausibleFrame(element.frame, bounds)) return null;
    const x = Math.round((element.frame.x - bounds.x + element.frame.width / 2) * pixelMap);
    const y = Math.round((element.frame.y - bounds.y + element.frame.height / 2) * pixelMap);
    return x >= 0 && y >= 0 && x < shot.width && y < shot.height ? { x, y } : null;
  };

  // 2. Keyboard allowlist (window-targeted).
  if (kinds.has("key")) {
    add({ id: `open_search${idSuffix}`, kind: "hotkey", risk: "none", keys: [keyMod, "f"], delivery: tracker.delivery, focusAfter: "search",
      description: `Press ${context.platform === "win32" ? "Ctrl+F" : "Command+F"} in the "${quote(appName)}" window to put keyboard focus in its search box.${deliverySuffix}${fg ? " This is the way to reach the search box now: a click cannot confirm keyboard focus." : ""}`,
      label: `按 ${keyModLabel} 打开搜索${deliveryLabel}`, expect: `A search box in the "${quote(appName)}" window has keyboard focus.` });
    let returnRisk = "submit", returnDescription, returnLabel, returnExpect;
    // Return is harmless only while a search box visibly holds this run's
    // search text, typed as keystrokes (which proves keyboard focus is there;
    // an accessibility write does not). Otherwise keyboard focus is uncertain
    // and Return could send a draft, so it stays a risky submit.
    const searchConfirmed = tracker.focus === "search" && Boolean(tracker.searchText) && tracker.searchByKeys === true &&
      (elements.some((element) => element.searchLike && normalizeName(element.value) === normalizeName(tracker.searchText)) ||
        // WeChat shows neither the search text nor a value: the landing
        // check's proof (results naming the literal, or the list under the
        // box reacting), still standing in this capture.
        context.searchProof === "holds");
    if (searchConfirmed && tracker.searchMoved) {
      returnRisk = "none";
      returnDescription = "Press Return to open the search result that is highlighted now (the arrow keys moved the highlight, so it may not be the first match).";
      returnLabel = "按回车打开当前选中的搜索结果";
      returnExpect = "The highlighted search result is open.";
    } else if (searchConfirmed) {
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
      returnDescription = `Press Return in the "${quote(appName)}" window. Keyboard focus is not confirmed: if a text box, list or dialog has focus this may open, submit or send whatever it holds.`;
      // The label reaches the extra-consent dialog: say what Return may do.
      returnLabel = "按回车（可能发送或提交输入框里的内容）";
      returnExpect = "The focused item is opened or submitted.";
    }
    if (!tracker.misdirected) {
      add({ id: `key_return${idSuffix}`, kind: "key", key: "return", risk: returnRisk, delivery: tracker.delivery, description: `${returnDescription}${deliverySuffix}`, label: `${returnLabel}${deliveryLabel}`, expect: returnExpect });
    }
    add({ id: "key_escape", kind: "key", key: "escape", risk: "none", delivery: tracker.delivery, description: "Press Escape to close the current menu, popover, dialog or search.", label: "按 Esc 关闭弹出内容", expect: "The menu, dialog or search is closed.", focusAfter: "none" });
    add({ id: "key_tab", kind: "key", key: "tab", risk: "none", delivery: tracker.delivery, description: "Press Tab to move keyboard focus to the next control.", label: "按 Tab 切换焦点", expect: "Keyboard focus moved to the next control." });
    add({ id: "key_down", kind: "key", key: "down", risk: "none", delivery: tracker.delivery, description: "Press the Down arrow key to move the highlight to the next item. In a list of search results the first match is already highlighted: do not press this before Return unless the first result is visibly not the one the task needs.", label: "按 ↓ 选择下一项", expect: "The selection moved down by one item." });
    add({ id: "key_up", kind: "key", key: "up", risk: "none", delivery: tracker.delivery, description: "Press the Up arrow key to move the highlight to the previous item.", label: "按 ↑ 选择上一项", expect: "The selection moved up by one item." });
    if (tracker.focus !== "none" && (tracker.searchText || tracker.composerText)) {
      add({ id: "key_backspace", kind: "key", key: "backspace", risk: "none", delivery: tracker.delivery, description: "Press Backspace once to delete the character before the cursor in the focused input box.", label: "按退格删除一个字", expect: "One character was removed from the focused input." });
    }
  }

  // 3. Type task literals: into the focused input (keyboard path) and into editable elements.
  if (kinds.has("type") && !tracker.misdirected) {
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
    const fields = elements.filter((element) => !tracker.elementsRefused && element.editable && !element.secure && element.enabled && element.token && !refused.has(element.identity))
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

  // 4a. After the target refused background input (or showed no effect), offer
  // distinct foreground clicks at the positions of task-relevant items, the
  // item Jev wanted first. Never an automatic retry. Input boxes are left
  // out: a position click cannot prove it moved keyboard focus (a WeChat
  // search box ignored one while its chat input kept focus), and text typed
  // "into focus" afterwards would land in whatever field still had it. Input
  // boxes are reached by keyboard (⌘F, Return on a search result) instead.
  if (kinds.has("click") && fg && pixelMap) {
    const positioned = elements
      .filter((element) => element.frame && element.enabled && !element.secure && !element.editable && element.text && element.clickable)
      .map((element) => ({ element, score: relevance(element, task) + (refused.has(element.identity) ? 200 : 0) }))
      .filter(({ element, score }) => refused.has(element.identity) || score >= 60)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    for (const { element } of positioned) {
      const point = pixelPoint(element);
      if (!point) continue;
      const risk = labelRisk(element.text);
      const matchesRecipient = Boolean(recipient && normalizeName(element.text) === normalizeName(recipient));
      add({ id: `point_${element.ref}_fg`, kind: "point", risk, point, elementRef: element.ref, delivery: "foreground",
        ...(element.token ? { elementIdentity: element.identity } : {}),
        editable: false, searchLike: false, messageLike: false, matchesRecipient, clickedText: element.text,
        ...(matchesRecipient ? { targetFrame: element.frame } : {}),
        description: `Click the ${element.roleShort} "${quote(element.text)}" at its position on screen with foreground delivery ("${quote(appName)}" comes to the front briefly) because background input was refused or had no effect.${risk === "send" ? sendClause(task) : risk !== "none" ? " This may be an irreversible action." : ""}`,
        label: `点击「${quote(element.text)}」（前台）`,
        expect: matchesRecipient ? `The conversation with "${quote(recipient)}" is open.` : `The "${quote(element.text)}" item reacted.` });
    }
  }

  if (kinds.has("click") && !tracker.elementsRefused) {
    const clickable = elements
      .filter((element) => element.token && element.enabled && element.clickable && !element.secure && (element.text || element.editable) && !refused.has(element.identity))
      .map((element) => ({ element, score: relevance(element, task) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, Math.min(16, room() - 2)));
    for (const { element } of clickable) {
      const risk = element.editable ? "none" : labelRisk(element.text);
      const matchesRecipient = Boolean(recipient && normalizeName(element.text) === normalizeName(recipient));
      add({ id: `click_${element.ref}`, kind: "click", risk, elementToken: element.token, elementIdentity: element.identity, elementRef: element.ref, delivery: "background",
        editable: element.editable, searchLike: element.searchLike, messageLike: element.messageLike, matchesRecipient, clickedText: element.text,
        ...(matchesRecipient && element.frame ? { targetFrame: element.frame } : {}),
        description: `Click the ${element.roleShort} "${quote(element.text || element.roleShort)}"${element.selected ? " (currently selected)" : ""}.${risk === "send" ? sendClause(task) : risk !== "none" ? " This may be an irreversible action." : ""}`,
        label: `点击「${quote(element.text || element.roleShort)}」`,
        expect: element.editable ? `The field "${quote(element.text || element.roleShort)}" has keyboard focus.` : matchesRecipient ? `The conversation with "${quote(recipient)}" is open.` : `The "${quote(element.text)}" control reacted.` });
    }
  }

  // 5. Coordinate fallback when the accessibility tree is sparse.
  if (kinds.has("click") && context.axSparse && pixelMap) {
    const points = elements
      .filter((element) => !element.token && element.frame && element.text && !element.secure && (parameterMatch(element.text, task.parameters) || labelRisk(element.text) === "send"))
      .slice(0, 4);
    for (const element of points) {
      const position = pixelPoint(element);
      if (!position || out.some((candidate) => candidate.kind === "point" && candidate.elementRef === element.ref)) continue;
      const { x, y } = position;
      const risk = labelRisk(element.text);
      const matchesRecipient = Boolean(recipient && normalizeName(element.text) === normalizeName(recipient));
      add({ id: `point_${element.ref}`, kind: "point", risk, point: { x, y }, elementRef: element.ref, delivery: tracker.delivery, matchesRecipient, clickedText: element.text,
        ...(matchesRecipient ? { targetFrame: element.frame } : {}),
        description: `Click at the screen position of the text "${quote(element.text)}" (it exposes no accessibility action, so the click uses window coordinates).${risk === "send" ? sendClause(task) : ""}${deliverySuffix}`,
        label: `点击文字「${quote(element.text)}」所在位置${deliveryLabel}`,
        expect: matchesRecipient ? `The conversation with "${quote(recipient)}" is open.` : `The "${quote(element.text)}" item reacted.` });
    }
  }

  // 6. Scroll the largest list.
  if (kinds.has("scroll") && room() > 1 && !tracker.elementsRefused) {
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
  const target = normalizeName(content);
  if (!target) return 0;
  const length = [...target].length;
  return elements.filter((element) => {
    if (element.editable) return false;
    const text = normalizeName(element.text);
    // A bubble may carry a short decoration (sender, time); long unrelated
    // paragraphs that merely contain a short text do not count.
    return text === target || (length >= 2 && text.includes(target) && [...text].length <= length + 16);
  }).length;
}

/**
 * Visible input boxes whose value holds `text`, split into search boxes,
 * message boxes (named or placed like a chat composer) and other inputs — an
 * unlabelled box might be either, so it never counts as the wrong kind.
 * Secure fields are never read.
 */
function typedTextSpots(elements, text) {
  const target = normalizeName(text);
  const spots = { search: 0, message: 0, other: 0, results: 0, listResults: 0 };
  if (!target) return spots;
  for (const element of Array.isArray(elements) ? elements : []) {
    // Non-editable items naming the literal: search results, when they grow
    // (counted apart when they are rows of a search list window).
    if (!element.editable) {
      if (normalizeName(element.text).includes(target)) spots[element.popup ? "listResults" : "results"] += 1;
      continue;
    }
    if (element.secure || !normalizeName(element.value).includes(target)) continue;
    if (element.searchLike) spots.search += 1;
    else if (element.messageBox) spots.message += 1;
    else spots.other += 1;
  }
  return spots;
}

/**
 * Elements a landing check reads: the target window's, plus the read-only
 * items of the search list hanging under its search box when the app draws
 * that list as a window of its own (the caller passes only that list's rows:
 * other floating windows, such as a suggestion popup above a message box,
 * never count). A list's own input boxes never count either.
 */
function landingView(elements, popupElements) {
  const main = Array.isArray(elements) ? elements : [];
  const popup = Array.isArray(popupElements) ? popupElements.filter((element) => element && !element.editable) : [];
  return popup.length ? [...main, ...popup] : main;
}

/** A search list hangs from the top band of the target window, where search
 * boxes sit: its top edge lies at most this far below the window's top
 * (points), or a quarter of the window's height when that is smaller. */
const LIST_TOP_BAND = 160;
/** A list is at least this tall and this wide (points); a tooltip is not. */
const LIST_MIN_HEIGHT = 60;
const LIST_MIN_WIDTH = 150;

/**
 * Search box suggestion or result lists that the app draws as windows of
 * their own (WeChat): floating same-app windows hanging from the top band of
 * the target window and big enough to be a list. Judged from WindowServer
 * geometry only — WeChat's accessibility frame for its search box does not
 * match the screen, so it cannot anchor anything. A popup over a message box
 * (low in the window), a tooltip or a badge is never one. `windowBounds`: the
 * target window; `popups`: [{ windowId, bounds, hash, read }], screen points.
 * Returns [{ windowId, hash, read }].
 */
function anchoredSearchLists(windowBounds, popups) {
  if (!windowBounds || !(windowBounds.width > 0 && windowBounds.height > 0)) return [];
  const band = Math.min(LIST_TOP_BAND, windowBounds.height / 4);
  const lists = [];
  for (const popup of Array.isArray(popups) ? popups : []) {
    const bounds = popup && popup.bounds;
    if (!bounds || !(bounds.width >= LIST_MIN_WIDTH && bounds.height >= LIST_MIN_HEIGHT)) continue;
    if (bounds.y < windowBounds.y - 8 || bounds.y > windowBounds.y + band) continue;
    // `read`: the window's own capture succeeded (its rows, if any, are known).
    lists.push({ windowId: String(popup.windowId), hash: typeof popup.hash === "string" && popup.hash ? popup.hash : null, read: popup.read !== false });
  }
  return lists;
}

/**
 * What one capture knows about search lists. `looked` only when the app's
 * floating windows could be listed (and the target window's bounds are
 * known) — otherwise "no list" means "could not look". `lists`: the search
 * lists; `ids`: every floating window listed.
 */
function searchListState({ looked, windowBounds, popups }) {
  const windows = Array.isArray(popups) ? popups : [];
  return {
    looked: Boolean(looked) && Boolean(windowBounds),
    lists: anchoredSearchLists(windowBounds, windows),
    ids: windows.map((popup) => String(popup.windowId)),
  };
}

/**
 * Window-local geometry of the floating windows and of the search box's
 * accessibility frame, rounded, for the run panel (checking a new app's
 * layout by eye). Never used for any decision.
 */
function floatingGeometry(windowBounds, popups, lists, elements) {
  if (!windowBounds) return null;
  const local = (rect) => ({ x: Math.round(rect.x - windowBounds.x), y: Math.round(rect.y - windowBounds.y), w: Math.round(rect.width), h: Math.round(rect.height) });
  const listIds = new Set((Array.isArray(lists) ? lists : []).map((list) => list.windowId));
  const box = (Array.isArray(elements) ? elements : []).find((element) => element && element.searchLike && element.frame);
  return {
    popups: (Array.isArray(popups) ? popups : []).slice(0, 2).map((popup) => ({ ...local(popup.bounds), list: listIds.has(String(popup.windowId)) })),
    searchBox: box ? local(box.frame) : null,
  };
}

/**
 * The search list under the search box appeared, or was redrawn, between the
 * look right before typing and now. Such a list closes when the box loses
 * keyboard focus, so a list that is open and reacted after the keystrokes
 * means they reached the box. Only what was actually looked at counts: a
 * failed look is never "there was no list", a missing picture never "it
 * redrew", and another window only replaces a list that is gone.
 */
function searchListReacted(before, now) {
  if (!before || !before.looked || !now || !now.looked || !now.lists.length) return false;
  if (!before.lists.length) return true;
  return before.lists.some((old) => {
    const same = now.lists.find((list) => list.windowId === old.windowId);
    if (same) return Boolean(old.hash && same.hash && old.hash !== same.hash);
    return !now.ids.includes(old.windowId);
  });
}

/**
 * Where text typed "into focus" went, judged against the input boxes that
 * already held it before typing: "expected" (the intended kind of box),
 * "elsewhere" (only a box of the other kind gained it — a search literal in a
 * chat's message box, or a message in a search box) or "unknown" (the app
 * exposes no values, nothing changed yet, or an unlabelled box gained it).
 * `elements`: landingView of this capture; `searchList`: searchListState now
 * (`check.beforeList` is the one taken right before typing, and
 * `check.rowsRead` whether that look read the list's rows). `by` names the
 * proof of a search: "value", "results" (in the target window) or "list"
 * (the search list's rows grew, or the list appeared or redrew).
 */
function typedLandingDetail(check, elements, searchList = null) {
  if (!check || !check.before) return { landed: "unknown", by: null };
  const after = typedTextSpots(elements, check.text);
  const gained = (kind) => after[kind] > (check.before[kind] || 0);
  // A search box that shows no value (WeChat) still proves itself by new
  // results naming the literal. Text stuck in a message box adds at most one
  // such item (a chat list's draft preview), so it takes at least two.
  const results = after.results - (check.before.results || 0);
  // A list's rows count only against rows read right before typing: a list
  // that already named the literal (recent searches) proves nothing new.
  const listResults = check.rowsRead === true ? after.listResults - (check.before.listResults || 0) : 0;
  if (check.field === "search") {
    if (gained("search")) return { landed: "expected", by: "value" };
    if (gained("message")) return { landed: "elsewhere", by: null };
    if (results >= 2) return { landed: "expected", by: "results" };
    if (listResults >= 2) return { landed: "expected", by: "list" };
    // WeChat's results are a separate window whose items may not be readable
    // at all: the list under the box appearing or redrawing is the proof.
    return searchListReacted(check.beforeList || null, searchList) ? { landed: "expected", by: "list" } : { landed: "unknown", by: null };
  }
  if (check.field === "message") return { landed: gained("message") || gained("other") ? "expected" : gained("search") ? "elsewhere" : "unknown", by: null };
  return { landed: gained("search") || gained("message") || gained("other") ? "expected" : "unknown", by: null };
}

function typedLanding(check, elements, searchList = null) {
  return typedLandingDetail(check, elements, searchList).landed;
}

/**
 * Whether the landing check's search proof still stands in this capture:
 * "holds", "gone" (the list closed, the results or the text disappeared — the
 * search box has most likely lost keyboard focus) or "unknown" (it could not
 * be looked at). "none" when there is no proof for the current search text.
 * A list proof stands while the list hangs under the box, whether or not its
 * rows could be read this time.
 */
function searchProof(tracker, elements, searchList) {
  if (!tracker || !tracker.searchSeen || tracker.searchSeen !== tracker.searchText) return "none";
  const text = normalizeName(tracker.searchText);
  if (tracker.searchSeenBy === "list") return !searchList || !searchList.looked ? "unknown" : searchList.lists.length ? "holds" : "gone";
  if (tracker.searchSeenBy === "results") return typedTextSpots(elements, tracker.searchText).results - (tracker.searchResultsBase || 0) >= 2 ? "holds" : "gone";
  if (tracker.searchSeenBy === "value") return (Array.isArray(elements) ? elements : []).some((element) => element.searchLike && normalizeName(element.value).includes(text)) ? "holds" : "gone";
  return "unknown";
}

/** The run's belief after a search proof is gone: the search box closed. */
function withdrawSearch(tracker) {
  return Object.freeze({ ...tracker, focus: tracker.focus === "search" ? "none" : tracker.focus, searchText: null, searchMoved: false, searchSeen: null, searchSeenBy: null, searchResultsBase: null });
}

/**
 * Evidence that a send reaches the granted recipient with the granted text.
 * All three must hold: the recipient is visible, the conversation was opened
 * by this run for that recipient (or the window title names it), and the
 * message input holds exactly the granted content.
 */
/* ------------------------------------------------------------------ */
/* Screen text (the system's text recognition, run in the main process */
/* on the target window's picture). Only these derived facts leave it: */
/* whether the granted recipient's name is the chat title, whether the */
/* composer holds exactly the granted text, how many copies are shown. */
/* ------------------------------------------------------------------ */

/** Chat titles sit in the window's top bar: a line whose middle lies at most
 * this far (points) below the window's top edge. */
const SCREEN_TITLE_BAND = 56;
/** Without a composer to anchor the chat pane, a title must start at least
 * this share of the window's width from its left edge (right of the list). */
const SCREEN_TITLE_MIN_X = 0.3;
/** The chat pane starts at most this far (points) left of the composer's text. */
const SCREEN_PANE_SLACK = 40;
/** A line is "the same place" as another within these distances (points). */
const SCREEN_SAME_X = 20;
const SCREEN_SAME_Y = 10;
const SCREEN_MAX_LINES = 400;
/** A group chat's member count shown after its name, e.g. "(3)". */
const TITLE_COUNT = /^[（(]\d+[)）]$/u;

/** Lossless comparison key: only whitespace is dropped (never a "(3)"). */
function screenKey(value) {
  return clean(value, 200).replace(/\s+/gu, "");
}

/** Recognized lines in window-local points (top-left origin), bounded and validated. */
function screenLines(screen) {
  if (!screen || !Array.isArray(screen.lines)) return [];
  return screen.lines.filter((line) => line && typeof line.text === "string" && line.text.trim() &&
    [line.x, line.y, line.w, line.h].every(Number.isFinite) && line.w > 0 && line.h > 0).slice(0, SCREEN_MAX_LINES);
}

function sentCopy(text, content) {
  // A bubble may carry a short decoration (a time, a read mark): as with the
  // accessibility count, only short lines that contain the text count.
  return text === content || ([...content].length >= 2 && text.includes(content) && [...text].length <= [...content].length + 16);
}

function samePlace(a, b) {
  return Math.abs(a.x - b.x) <= SCREEN_SAME_X && Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= SCREEN_SAME_Y;
}

/** Text directly above or below a line and overlapping it sideways: more of the same box. */
function adjacentText(lines, line) {
  const gap = line.h * 0.6;
  return lines.some((other) => other !== line && !SEND_LABEL.test(clean(other.text, 40)) &&
    other.x < line.x + line.w + SCREEN_PANE_SLACK && other.x + other.w > line.x - 10 &&
    ((other.y + other.h <= line.y + 2 && line.y - (other.y + other.h) < gap) || (other.y >= line.y + line.h - 2 && other.y - (line.y + line.h) < gap)));
}

/**
 * The composer line after the run typed the granted text: the lowest line
 * reading exactly that text which was not on screen before the typing
 * (`before`: the window's lines read after the chat opened, before typing),
 * with no other text right above or below it. An old bubble or list preview
 * with the same text was there before; a draft the text was added to makes
 * the line read differently or leaves text next to it. Null when unsure.
 */
function findComposerLine(lines, content, before) {
  if (!content || !before) return null;
  const earlier = screenLines(before);
  const fresh = lines.filter((line) => screenKey(line.text) === content &&
    !earlier.some((old) => samePlace(old, line) && screenKey(old.text) === content));
  const line = fresh.reduce((lowest, item) => (!lowest || item.y > lowest.y ? item : lowest), null);
  return line && !adjacentText(lines, line) ? line : null;
}

function localFrame(frame, windowBounds) {
  return { x: frame.x - windowBounds.x, y: frame.y - windowBounds.y, w: frame.width, h: frame.height };
}
function within(line, box) {
  const cx = line.x + line.w / 2, cy = line.y + line.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

/**
 * What the window's recognized text says about the granted send.
 * - composerLine: before the send, the composer line (findComposerLine);
 *   after it (`composerAt` = that line), a line at the same place that still
 *   contains the text (a caret or a partial read still counts). The composer
 *   anchors the chat pane: its text starts near the pane's left edge.
 * - recipientInTitle: a line in the top bar of the chat pane reads exactly the
 *   recipient's name (not "姐姐(3)", a group, and not inside a search box).
 * - copies: chat-pane lines above the composer that contain the text.
 * `anchored` is false when no composer was found: the title check then only
 * uses a fixed share of the window's width, and nothing authorizes a send.
 */
function screenSendFacts({ task, screen, windowBounds, before = null, composerAt = null, elements = [] }) {
  const irreversible = task.irreversible;
  if (!irreversible || irreversible.kind !== "send_message" || !screen || !windowBounds || !(windowBounds.width > 0)) return null;
  const lines = screenLines(screen);
  const recipient = screenKey(irreversible.recipient || "");
  const content = screenKey(irreversible.content || "");
  const composerLine = composerAt
    ? lines.find((line) => samePlace(line, composerAt) && screenKey(line.text).includes(content)) || null
    : findComposerLine(lines, content, before);
  const anchor = composerAt || composerLine;
  const paneLeft = anchor ? anchor.x - SCREEN_PANE_SLACK : windowBounds.width * SCREEN_TITLE_MIN_X;
  const searchBoxes = (Array.isArray(elements) ? elements : []).filter((element) => element && element.searchLike && plausibleFrame(element.frame, windowBounds)).map((element) => localFrame(element.frame, windowBounds));
  const titleBand = (line) => line.y + line.h / 2 <= SCREEN_TITLE_BAND && line.x >= paneLeft && !searchBoxes.some((box) => within(line, box));
  const titles = lines.filter(titleBand);
  const recipientInTitle = Boolean(recipient) && titles.some((line) => screenKey(line.text) === recipient &&
    !titles.some((other) => other !== line && TITLE_COUNT.test(screenKey(other.text)) && other.x >= line.x + line.w - 4 && other.x <= line.x + line.w + SCREEN_PANE_SLACK && Math.abs(other.y - line.y) < line.h));
  const copies = content && anchor
    ? lines.filter((line) => line.x >= paneLeft && line.y + line.h <= anchor.y - 4 && !titleBand(line) && sentCopy(screenKey(line.text), content)).length
    : 0;
  return {
    anchored: Boolean(anchor),
    recipientInTitle,
    composerLine: composerLine ? { x: composerLine.x, y: composerLine.y, w: composerLine.w, h: composerLine.h } : null,
    copies,
  };
}

function sendEvidence({ task, tracker, observation }) {
  const irreversible = task.irreversible;
  if (!irreversible || !irreversible.recipient || !irreversible.content) return { ok: false, reason: "未授予发送消息" };
  const recipient = normalizeName(irreversible.recipient);
  const content = normalizeName(irreversible.content);
  const labels = observation.elements.filter((element) => !element.editable);
  const exactRecipient = labels.filter((element) => normalizeName(element.text) === recipient).length;
  const titleNamesRecipient = normalizeName(observation.windowTitle || "") === recipient;
  const recipientVisible = titleNamesRecipient || exactRecipient > 0 || observation.treeTexts.some((text) => normalizeName(text) === recipient);
  // Opening a chat by clicking the exact contact is strong provenance. Search
  // + Return may open another result (a group, an article), so it also needs
  // the name shown twice (list item and chat header), a selected list item
  // or the window title.
  const openedByRun = tracker.conversationTarget !== null && normalizeName(tracker.conversationTarget) === recipient;
  const selectedRecipient = labels.some((element) => element.selected && normalizeName(element.text) === recipient);
  // The recipient's own list row is always visible, whichever chat is open,
  // so a chat this run opened (by a confirmed click or by search) also needs
  // the name a second time (the chat header), a selected row or the title.
  const provenance = titleNamesRecipient || selectedRecipient || (openedByRun && exactRecipient >= 2);
  const inputs = observation.elements.filter((element) => element.editable && !element.searchLike);
  const typedByRun = tracker.composerText !== null && normalizeName(tracker.composerText) === content && (tracker.focus === "conversation" || tracker.focus === "field");
  const inputHolds = inputs.some((element) => normalizeName(element.value) === content)
    || (inputs.every((element) => !element.value) && typedByRun);
  // An app that shows neither the chat nor the composer to accessibility
  // (WeChat): the window's recognized text is a complete proof on its own —
  // the chat pane's title reads exactly the recipient, and the composer line
  // the run's typing brought up reads exactly the text with nothing next to it.
  const screen = observation.screen || null;
  if ((!recipientVisible || !provenance) && screen && screen.anchored && screen.recipientInTitle && screen.composerLine &&
    typedByRun && inputs.every((element) => !element.value)) return { ok: true, by: "screen" };
  if (!recipientVisible) return { ok: false, reason: `界面上没有看到联系人「${irreversible.recipient}」` };
  if (!provenance) return { ok: false, reason: `无法确认当前打开的聊天就是「${irreversible.recipient}」` };
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
  if (tracker.misdirected && (candidate.kind === "type" || (candidate.kind === "key" && candidate.key === "return") || candidate.risk !== "none")) {
    return { allowed: false, reason: "刚才输入的文字落到了别的输入框，不再继续输入、按回车或发送" };
  }
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
  // Anything but a clean refusal may have reached the app.
  const attempted = status !== "failed" && status !== "blocked";
  const next = { ...tracker, typed: [...tracker.typed], irreversibleCounts: { ...tracker.irreversibleCounts }, refused: [...(tracker.refused || [])] };
  const backgroundMiss = (status === "failed" || status === "no_effect") && candidate.delivery === "background";
  if (backgroundMiss && ["key", "hotkey", "type", "point", "click"].includes(candidate.kind)) {
    // Focus believed from background input may be wrong (those keys may have
    // gone nowhere): the foreground rung starts from unknown focus. An
    // element-addressed action Cua refused outright never touched the app,
    // so it leaves the focus belief as it was (a search box opened by ⌘F
    // keeps keyboard focus; the next step can type into it).
    const untouched = status === "failed" && Boolean(candidate.elementIdentity);
    Object.assign(next, untouched ? { delivery: "foreground" } : { delivery: "foreground", focus: "none", searchText: null, searchMoved: false });
  }
  // The same element is not offered again in the background; a foreground
  // position click for it becomes a distinct candidate instead.
  if (backgroundMiss && candidate.elementIdentity && !next.refused.includes(candidate.elementIdentity)) next.refused = [...next.refused, candidate.elementIdentity].slice(-24);
  // Only a confirmed click (Cua read the selection back, or the clicked row
  // newly shows as selected) tells where keyboard focus and the open
  // conversation are. After any other click that may have happened —
  // unverifiable, no visible effect, unknown, or a risky button — neither is
  // known, so nothing is typed "into focus" until a keyboard route sets it.
  // Only an element-addressed click on an input box cannot switch the chat.
  if ((candidate.kind === "click" || candidate.kind === "point") && attempted && status !== "delivered") {
    Object.assign(next, candidate.editable && candidate.kind === "click"
      ? { focus: "none", searchMoved: false }
      : { focus: "none", searchText: null, searchMoved: false, conversationTarget: null, conversationVia: null, composerText: null });
  }
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
      // Another app starts from the background rung with its own elements;
      // the executor puts it on the foreground rung when that app needs it.
      Object.assign(next, { focus: "none", searchText: null, searchMoved: false, composerText: null, conversationTarget: null, conversationVia: null, delivery: "background", elementsRefused: false, preferForeground: false, refused: [] });
      break;
    case "hotkey":
      // Re-opening search allows the search literal to be typed again.
      Object.assign(next, { focus: "search", searchText: null, searchMoved: false, searchSeen: null, searchSeenBy: null, searchResultsBase: null, typed: next.typed.filter((entry) => entry.field !== "focus:search") });
      break;
    case "type": {
      next.typed.push({ field: candidate.elementIdentity || `focus:${candidate.field}`, text: candidate.text });
      // An element-addressed (accessibility) write does not move keyboard
      // focus: it tells what the box holds, never where Return will go.
      const focusAfter = candidate.elementIdentity ? tracker.focus : null;
      // A second landed literal may have been appended to the first: the
      // application no longer knows the exact field content.
      if (candidate.field === "search") Object.assign(next, { focus: focusAfter ?? "search", searchText: tracker.searchText ? null : candidate.text, searchMoved: false, searchByKeys: !candidate.elementIdentity, searchSeen: null, searchSeenBy: null, searchResultsBase: null });
      else if (candidate.field === "message") Object.assign(next, { focus: focusAfter ?? (tracker.focus === "field" ? "field" : "conversation"), composerText: tracker.composerText ? null : candidate.text });
      else Object.assign(next, { focus: focusAfter ?? "field", composerText: tracker.composerText ? null : candidate.text });
      break;
    }
    case "key":
      if (candidate.key === "return") {
        if (tracker.focus === "search" && candidate.risk === "none") {
          // After ↓/↑ another result may be highlighted: the chat is opened,
          // but not known to be the searched one.
          const opened = !tracker.searchMoved && tracker.searchText && recipient && normalizeName(tracker.searchText) === normalizeName(recipient) ? tracker.searchText : null;
          Object.assign(next, { focus: "conversation", conversationTarget: opened, conversationVia: opened ? "search" : null, composerText: null, searchText: null, searchMoved: false, typed: next.typed.filter((entry) => !entry.field.startsWith("focus:")) });
        }
      } else if (candidate.key === "escape") {
        Object.assign(next, { focus: tracker.focus === "search" ? "none" : tracker.focus, searchText: null, searchMoved: false });
      } else if (candidate.key === "backspace") {
        // The exact remaining text is unknown after a deletion.
        Object.assign(next, { searchText: null, composerText: null, typed: next.typed.filter((entry) => !entry.field.startsWith("focus:")) });
      } else if (candidate.key === "tab") {
        // Focus moved to a control the run cannot see.
        Object.assign(next, { focus: "none", searchText: null, searchMoved: false });
      } else if (candidate.key === "down" || candidate.key === "up") {
        // In a search the highlighted result moved; anywhere else an arrow key
        // may have moved a list selection and switched the open conversation.
        if (tracker.focus === "search") next.searchMoved = true;
        else Object.assign(next, { focus: "none", conversationTarget: null, conversationVia: null, composerText: null });
      }
      break;
    case "click":
    case "point":
      // Unconfirmed clicks were handled above.
      if (status !== "delivered") break;
      if (candidate.editable) {
        Object.assign(next, { focus: candidate.searchLike ? "search" : candidate.messageLike ? (tracker.conversationTarget ? "conversation" : "field") : "field" });
      } else if (candidate.matchesRecipient) {
        Object.assign(next, { focus: "conversation", conversationTarget: recipient, conversationVia: "click", composerText: null, searchText: null });
      } else {
        Object.assign(next, { focus: "none", conversationTarget: null, conversationVia: null, composerText: null, searchText: null });
      }
      break;
    default:
      break;
  }
  if (status === "delivered" && candidate.delivery === "foreground") next.delivery = "foreground";
  return Object.freeze(next);
}

function facts({ tracker, task, observation, sendBaseline, appName, appRunning, targetWindow, landing, searchListShown = false, screen = null, screenBaseline = null }) {
  const content = task.irreversible && task.irreversible.content;
  let sendEvidenceFacts;
  if (tracker.sendCount > 0 && content && sendBaseline !== null && observation) {
    const inputs = observation.elements.filter((element) => element.editable && !element.searchLike);
    const inputValues = inputs.filter((element) => element.value);
    sendEvidenceFacts = {
      before: sendBaseline,
      after: sentTextCount(observation.elements, content),
      inputStillHasText: inputValues.length ? inputValues.some((element) => normalizeName(element.value).includes(normalizeName(content))) : inputs.length ? false : null,
    };
    // The app shows neither its bubbles nor its composer to accessibility
    // (WeChat): count the copies read off the screen instead, against the
    // copies read right before the send, and look at the composer's place.
    if (screen && screen.anchored && screenBaseline && screenBaseline.composerLine && sendEvidenceFacts.before === 0 && sendEvidenceFacts.after === 0 && !inputValues.length) {
      sendEvidenceFacts = { before: screenBaseline.copies, after: screen.copies, inputStillHasText: Boolean(screen.composerLine), screen: true };
    }
  }
  // Before the send: what the screen shows about the chat and the composer.
  const screenCheck = screen && tracker.sendCount === 0 && (screen.recipientInTitle || screen.composerLine)
    ? { recipientInTitle: screen.recipientInTitle, composerHoldsText: Boolean(screen.anchored && screen.composerLine) }
    : null;
  return {
    focus: tracker.focus,
    ...(tracker.searchText ? { typedIntoSearch: tracker.searchText } : {}),
    ...(tracker.composerText ? { typedIntoMessageBox: tracker.composerText } : {}),
    ...(tracker.conversationTarget ? { conversationOpenedFor: tracker.conversationTarget } : {}),
    irreversibleDone: tracker.sendCount > 0 || Object.values(tracker.irreversibleCounts).some((count) => count > 0),
    ...(sendEvidenceFacts ? { sendEvidence: sendEvidenceFacts } : {}),
    ...(screenCheck ? { screenCheck } : {}),
    ...(appName ? { targetApp: appName } : {}),
    appRunning: Boolean(appRunning),
    // "hidden": minimized, on another Space or without a main window, so the
    // observation is empty until the app is brought to the front.
    ...(targetWindow === "visible" || targetWindow === "hidden" || targetWindow === "none" ? { targetWindow } : {}),
    // Only on the first observation after text was typed "into focus".
    ...(landing ? { typedLanding: { field: landing.field, text: landing.text, landed: landing.landed } } : {}),
    // A list hangs under the search box (suggestions or results), drawn as a
    // window of its own whose items the observation may not show: the search
    // box is open.
    ...(searchListShown ? { searchListShown: true } : {}),
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
    "· 执行时目标应用可能会被切到前台（任务结束后回到同频）",
  ];
  if (platform === "darwin") {
    const names = { accessibility: "辅助功能", screenRecording: "屏幕录制" };
    lines.push(missingPermissions.length
      ? `· 需要的系统权限：${missingPermissions.map((item) => names[item]).join("、")}（点“允许并开始”后系统会一并申请，未开启时会打开对应的系统设置页面）`
      : screenRecordingSkipped
        ? "· 系统权限：辅助功能已开启；屏幕录制未开启，本次只读取界面结构，不使用截图坐标"
        : "· 系统权限：辅助功能、屏幕录制已开启");
  }
  lines.push("", "同频会读取目标应用窗口的界面结构，由 Jev 决策服务逐步选择下一步（不上传截图）；发送前后会在本机识别窗口里的文字，只用来核对聊天对象、要发的内容和是否已发出（识别的文字不上传）。删除、付款等未写在上面的不可逆操作会先停下来再次询问你。");
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
  anchoredSearchLists,
  authorizeCandidate,
  buildCandidates,
  consentDialog,
  emptyTracker,
  extraConsentDialog,
  extractTreeTexts,
  facts,
  foregroundFirst,
  floatingGeometry,
  keypadRelevance,
  labelRisk,
  landingView,
  modelElements,
  nextTracker,
  normalizeName,
  occurrences,
  projectObservation,
  publicCandidate,
  recipientNewlySelected,
  screenSendFacts,
  searchListReacted,
  searchListState,
  searchProof,
  sendEvidence,
  sentTextCount,
  typedLanding,
  typedLandingDetail,
  typedTextSpots,
  validateLimits,
  validateTaskSpec,
  withdrawSearch,
};
