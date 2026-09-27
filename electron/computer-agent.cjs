"use strict";

/**
 * Unified computer-operation executor host (Electron main process).
 *
 * The owner-specified loop is: instruction → task spec → ONE consent →
 * {Cua Driver reads the target window → closed candidate set → Jev chooses →
 * authorization/scope check → Cua Driver executes → re-observe/verify} until
 * done or stopped. The renderer orchestrates and the server asks Jev, but this
 * process is the authority for everything that touches the computer:
 *
 *   consent  re-validates the task spec, shows ONE native dialog (scope and
 *            any missing macOS permissions), requests the missing permissions
 *            together through the Cua Driver Electron helpers, opens the exact
 *            System Settings panes and waits, then starts a Cua Driver session.
 *   observe  captures the target app window (accessibility tree first, a
 *            screenshot only when the tree is sparse) and freezes a closed
 *            candidate table bound to this observation.
 *   execute  resolves the echoed candidate id only through that table, checks
 *            the consent grant, executes once and reports an honest outcome.
 *            Uncertain input is never replayed.
 *   stop     Stop button, Esc, window close, logout or quit.
 */

const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const policy = require("./computer-agent-policy.cjs");
const {
  CUA_DRIVER_VERSION,
  loadPackagedOrInstalledSdk,
  probePlatform,
  validateSdk,
  withTimeout,
} = require("./computer-use.cjs");

const RUN_ID = /^cr_[0-9a-f]{32}$/;
const OBSERVATION_ID = /^ob_[0-9a-f]{24}$/;
const CANDIDATE_ID = /^[a-z][a-z0-9_]{0,47}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu;
const MAX_WINDOW_ID = (1n << 64n) - 1n;

const TIMING = Object.freeze({
  observationTtlMs: 90_000,
  nativeTimeoutMs: 8_000,
  launchTimeoutMs: 15_000,
  settleMs: 500,
  launchSettleMs: 2_000,
  deadlineGraceMs: 30_000,
  openPaneAfterMs: 4_000,
  screenRecordingGraceMs: 20_000,
});
// Chat apps list many conversations and messages before the input box, so the
// walk is generous; only a ranked, bounded projection ever leaves this process.
const CAPTURE = Object.freeze({ maxElements: 1000, maxDepth: 40, maxDimension: 1280, maxTreeChars: 128 * 1024, sparseBelow: 6 });
// Same-app windows over the target (WeChat's search list is its own window):
// read-only extras of each capture, small and few.
const POPUP_CAPTURE = Object.freeze({ maxWindows: 2, maxElements: 200, maxDepth: 30, maxDimension: 320, maxTexts: 40 });
// The window's picture read by the system's text recognition around a send
// (chat title, composer, sent copies). Large enough for 12pt CJK text.
const SCREEN_TEXT = Object.freeze({ maxDimension: 2000, maxLines: 400, maxLineChars: 120 });
/** Apps known to take no background input (their accessibility nodes cannot be tied to the window). */
const FOREGROUND_FIRST_BUNDLES = new Set(["com.tencent.xinwechat"]);
/** Captures on which focus-typed text is looked for before the check lapses. */
const TYPE_CHECK_LOOKS = 3;

const SAFE_MESSAGES = Object.freeze({
  busy: "上一个电脑操作步骤还在进行，请稍候",
  run_active: "已有一个电脑任务在运行，请先停止它",
  invalid_input: "电脑任务参数无效，未执行任何操作",
  invalid_task: "电脑任务结构未通过本机校验，未执行任何操作",
  blocked_app: "出于安全考虑，同频 AI 不操作终端、钥匙串、系统设置、脚本工具或同频自身",
  unsupported: "当前系统不支持同频电脑操作",
  sdk_unavailable: "Cua Driver 本机能力不可用",
  sdk_api_mismatch: "Cua Driver 接口与当前安全适配层不匹配",
  sdk_version_mismatch: "Cua Driver 本机版本不匹配",
  consent_denied: "你没有允许本次电脑操作，未执行任何动作",
  permission_missing: "同频还没有获得「辅助功能」权限，无法读取和操作其他应用。请在系统设置中打开后重新发起",
  session_start_failed: "电脑操作会话启动失败，未执行任何动作",
  session_not_active: "电脑操作会话已结束",
  stopped: "电脑操作已停止",
  observation_stale: "界面观察已过期，请重新读取后再决定",
  candidate_unknown: "选择的动作不在本次候选中，未执行",
  step_limit: "已达到本次电脑任务的步数上限，已停止",
  time_limit: "已超过本次电脑任务的时长上限，已停止",
  observe_failed: "无法读取目标应用的界面",
});

function failure(code, message = SAFE_MESSAGES[code] || "电脑操作不可用") {
  return { ok: false, error: { code, message } };
}
function success(value) {
  return { ok: true, value };
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function safeText(value, max = 512) {
  if (typeof value !== "string") return "";
  return [...value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim()].slice(0, max).join("");
}
function safeToken(value, max = 1_024) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\s]/u.test(value) ? value : null;
}
function bigString(value) {
  if (value === undefined || value === null) return null;
  try { return BigInt(value).toString(); } catch { return null; }
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function safeCode(value) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value.toLowerCase() : null;
}
function normKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s._\-·]+/gu, "");
}

/* ------------------------------------------------------------------ */
/* Applications.                                                       */
/* ------------------------------------------------------------------ */

/** Well-known Chinese/English names so a task spec that says 微信 finds WeChat. */
const APP_ALIASES = Object.freeze([
  { names: ["微信", "wechat", "weixin"], bundleIds: ["com.tencent.xinwechat"] },
  { names: ["企业微信", "wecom", "wework"], bundleIds: ["com.tencent.weworkmac"] },
  { names: ["qq"], bundleIds: ["com.tencent.qq"] },
  { names: ["钉钉", "dingtalk"], bundleIds: ["com.alibaba.dingtalkmac"] },
  { names: ["飞书", "feishu", "lark"], bundleIds: [] },
  { names: ["备忘录", "notes"], bundleIds: ["com.apple.notes"] },
  { names: ["信息", "messages", "imessage"], bundleIds: ["com.apple.mobilesms"] },
  { names: ["邮件", "mail"], bundleIds: ["com.apple.mail"] },
  { names: ["访达", "finder"], bundleIds: ["com.apple.finder"] },
  { names: ["safari", "safari浏览器"], bundleIds: ["com.apple.safari"] },
  { names: ["提醒事项", "reminders"], bundleIds: ["com.apple.reminders"] },
  { names: ["日历", "calendar"], bundleIds: ["com.apple.ical"] },
]);

/** Shells, credential stores, OS settings, automation tools and 同频 itself are never targets. */
const BLOCKED_APPS = Object.freeze([
  { names: ["终端", "terminal", "命令行"], bundleIds: ["com.apple.terminal"] },
  { names: ["iterm", "iterm2"], bundleIds: ["com.googlecode.iterm2"] },
  { names: ["warp"], bundleIds: ["dev.warp.warp-stable"] },
  { names: ["powershell", "windowsterminal", "命令提示符", "cmd"], bundleIds: [] },
  { names: ["钥匙串访问", "钥匙串", "keychainaccess", "密码"], bundleIds: ["com.apple.keychainaccess", "com.apple.passwords"] },
  { names: ["系统设置", "系统偏好设置", "systemsettings", "systempreferences", "设置"], bundleIds: ["com.apple.systempreferences"] },
  { names: ["脚本编辑器", "scripteditor"], bundleIds: ["com.apple.scripteditor2"] },
  { names: ["自动操作", "automator"], bundleIds: ["com.apple.automator"] },
  { names: ["同频", "tongpin"], bundleIds: [] },
]);

function groupFor(groups, name, bundleId) {
  const key = normKey(name);
  const bundle = String(bundleId || "").toLowerCase();
  return groups.find((group) => group.names.includes(key) || (bundle && group.bundleIds.includes(bundle))) || null;
}
function isBlockedApp(name, bundleId) {
  return Boolean(groupFor(BLOCKED_APPS, name, bundleId));
}
function appMatches(grant, info) {
  const infoName = normKey(info.name);
  const infoBundle = String(info.bundleId || "").toLowerCase();
  if (grant.bundleId && infoBundle && grant.bundleId.toLowerCase() === infoBundle) return true;
  const group = groupFor(APP_ALIASES, grant.name, grant.bundleId);
  if (group && ((infoBundle && group.bundleIds.includes(infoBundle)) || group.names.includes(infoName))) return true;
  return Boolean(infoName) && normKey(grant.name) === infoName;
}

/* ------------------------------------------------------------------ */
/* Cua Driver data normalization (every value is untrusted).           */
/* ------------------------------------------------------------------ */

function normalizeBounds(raw) {
  if (!raw || typeof raw !== "object") return null;
  const width = raw.width ?? raw.w;
  const height = raw.height ?? raw.h;
  if (![raw.x, raw.y, width, height].every(finite) || width <= 0 || height <= 0) return null;
  return { x: raw.x, y: raw.y, width, height };
}

function normalizeWindowInfo(raw, hostPid) {
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.pid) || raw.pid <= 0 || raw.pid === hostPid) return null;
  let windowId;
  try { windowId = BigInt(raw.windowId); } catch { return null; }
  if (windowId <= 0n || windowId > MAX_WINDOW_ID) return null;
  const bounds = normalizeBounds(raw.bounds);
  if (!bounds) return null;
  let zIndex = null;
  try { if (raw.zIndex !== undefined && raw.zIndex !== null) zIndex = Number(BigInt(raw.zIndex)); } catch { zIndex = null; }
  return {
    pid: raw.pid,
    windowId: windowId.toString(),
    appName: safeText(raw.appName, 160),
    title: safeText(raw.title, 160),
    bounds,
    visible: raw.isOnScreen === true && raw.minimized !== true,
    minimized: raw.minimized === true,
    layer: Number.isInteger(raw.layer) ? raw.layer : 0,
    zIndex: Number.isFinite(zIndex) ? zIndex : null,
  };
}

/** Front-most normal window of the app (higher z_index is closer to the front). */
function chooseWindow(windows) {
  const normal = windows.filter((window) => window.layer === 0 && window.bounds.width >= 120 && window.bounds.height >= 80);
  const area = (window) => window.bounds.width * window.bounds.height;
  const pick = (items) => {
    if (!items.length) return null;
    const ranked = items.some((window) => window.zIndex !== null)
      ? [...items].sort((a, b) => (b.zIndex ?? -Infinity) - (a.zIndex ?? -Infinity) || area(b) - area(a))
      : [...items].sort((a, b) => area(b) - area(a));
    return ranked[0];
  };
  const visible = pick(normal.filter((window) => window.visible));
  if (visible) return { window: visible, hidden: false };
  const hidden = pick(normal.filter((window) => !window.visible));
  return hidden ? { window: hidden, hidden: true } : null;
}

/**
 * Output of the fixed window-list script run by computer-agent-host.cjs:
 * rows of [windowId, layer, x, y, width, height] for one app's on-screen
 * windows on CGWindow layers other than 0 (search lists, popovers and menus
 * drawn as windows of their own). Cua Driver's list_windows reports layer-0
 * windows only. Untrusted text: malformed rows are dropped, and each record
 * still passes normalizeWindowInfo. null when the output is not a list at
 * all: the windows could not be listed, which is not "there are none".
 */
function parseLayeredWindows(text, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let rows;
  try { rows = JSON.parse(String(text ?? "").trim()); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, 20)
    .filter((row) => Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every(finite) && Number.isInteger(row[0]) && Number.isInteger(row[1]))
    .map(([windowId, layer, x, y, width, height]) => ({ windowId, pid, layer, bounds: { x, y, width, height }, isOnScreen: true, minimized: false, title: "", appName: "" }));
}

/**
 * Rows of the text recognizer script (recognizeWindowText in the host):
 * [text, confidence, x, y, width, height], coordinates normalized to the
 * picture with Vision's bottom-left origin. Untrusted output: malformed rows
 * are dropped; null when it is not a list (recognition unavailable).
 */
function parseRecognizedText(text) {
  let rows;
  try { rows = JSON.parse(String(text ?? "").trim()); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const unit = (value) => finite(value) && value >= -0.01 && value <= 1.01;
  return rows.slice(0, SCREEN_TEXT.maxLines)
    .filter((row) => Array.isArray(row) && row.length >= 6 && typeof row[0] === "string" && row[0].length <= 400 &&
      finite(row[1]) && row.slice(2, 6).every(unit) && row[4] > 0 && row[5] > 0)
    .map(([text, confidence, x, y, width, height]) => [text, confidence, x, y, width, height]);
}

/**
 * Visible windows of the target's own app floating over the target: smaller
 * than it, lying mostly inside it and in front of it when the stacking order
 * is known. Apps draw search result lists, menus and popovers this way
 * (WeChat's search list is such a window); a capture of the target window
 * alone never shows them.
 */
function attachedWindows(windows, target) {
  if (!target || !target.bounds) return [];
  const area = (bounds) => bounds.width * bounds.height;
  const inside = (bounds) => {
    const width = Math.min(bounds.x + bounds.width, target.bounds.x + target.bounds.width) - Math.max(bounds.x, target.bounds.x);
    const height = Math.min(bounds.y + bounds.height, target.bounds.y + target.bounds.height) - Math.max(bounds.y, target.bounds.y);
    return width > 0 && height > 0 ? width * height : 0;
  };
  const inFront = (window) => window.layer > target.layer ||
    (window.layer === target.layer && (window.zIndex === null || target.zIndex === null || window.zIndex > target.zIndex));
  return (Array.isArray(windows) ? windows : [])
    .filter((window) => window && window.pid === target.pid && window.windowId !== target.windowId && window.visible)
    .filter((window) => window.bounds.width >= 40 && window.bounds.height >= 24 && area(window.bounds) < area(target.bounds))
    .filter((window) => inside(window.bounds) >= area(window.bounds) / 2 && inFront(window))
    .sort((a, b) => b.layer - a.layer || (b.zIndex ?? 0) - (a.zIndex ?? 0))
    .slice(0, POPUP_CAPTURE.maxWindows);
}

function normalizeElement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = safeText(raw.role, 60);
  if (!role) return null;
  const token = safeToken(raw.elementToken);
  const frame = normalizeBounds(raw.frame);
  return {
    role,
    depth: Number.isInteger(raw.depth) && raw.depth >= 0 ? raw.depth : 0,
    elementIndex: bigString(raw.elementIndex),
    parentIndex: bigString(raw.parentIndex),
    ...(token ? { elementToken: token } : {}),
    label: safeText(raw.label),
    value: safeText(raw.value),
    valueDescription: safeText(raw.valueDescription),
    enabled: raw.enabled !== false,
    selected: raw.selected === true,
    actions: Array.isArray(raw.actions) ? raw.actions.slice(0, 20).map((action) => safeText(action, 60)).filter(Boolean) : [],
    ...(frame ? { frame } : {}),
  };
}

function normalizeState(raw, target) {
  if (!raw || typeof raw !== "object" || raw.pid !== target.pid) return null;
  if (bigString(raw.windowId) !== target.windowId) return null;
  const elements = Array.isArray(raw.elements)
    ? raw.elements.slice(0, CAPTURE.maxElements).map(normalizeElement).filter(Boolean)
    : [];
  const width = raw.screenshotWidth, height = raw.screenshotHeight;
  return {
    windowTitle: safeText(raw.windowTitle, 160) || target.title,
    treeMarkdown: typeof raw.treeMarkdown === "string" ? raw.treeMarkdown.slice(0, CAPTURE.maxTreeChars) : "",
    elements,
    windowBounds: normalizeBounds(raw.windowBounds) || target.bounds,
    screenshot: finite(width) && finite(height) && width > 0 && height > 0
      ? { width, height, frameValid: raw.screenshotFrameValid === true }
      : null,
  };
}

function isSparse(elements) {
  return elements.filter((element) => element.elementToken && element.enabled && (element.label || element.value)).length < CAPTURE.sparseBelow;
}

function semanticFingerprint(state) {
  return createHash("sha256").update(JSON.stringify([
    state.windowTitle,
    state.elements.map((element) => [element.role, element.label, element.value, element.selected, element.enabled]),
  ])).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Cua Driver tool arguments (fixed keys; uint64 window id stays exact). */
/* ------------------------------------------------------------------ */

function targetJson(target) {
  // pid and windowId are validated integers; window_id is written as a JSON
  // integer from its decimal string so the uint64 is never rounded.
  return `{"kind":"window","pid":${target.pid},"window_id":${target.windowId}}`;
}
function toolJson(fields, target, session, delivery) {
  const parts = Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
  parts.push(`"target":${targetJson(target)}`, `"session":${JSON.stringify(session)}`, `"delivery_mode":${JSON.stringify(delivery === "foreground" ? "foreground" : "background")}`);
  return `{${parts.join(",")}}`;
}

function toolSchemas(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const tools = Array.isArray(parsed) ? parsed : parsed && parsed.tools;
    return new Map((Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === "string").map((tool) => [tool.name, tool.inputSchema]));
  } catch {
    return new Map();
  }
}
function supportsWindowInput(schema, field, elementTargeted) {
  const properties = schema && schema.properties;
  const modes = properties && properties.delivery_mode && properties.delivery_mode.enum;
  return Boolean(schema && schema.type === "object" && schema.additionalProperties === false &&
    Array.isArray(schema.required) && schema.required.includes(field) && properties[field] &&
    properties.target && properties.session && Array.isArray(modes) &&
    modes.includes("background") && modes.includes("foreground") &&
    (!elementTargeted || (properties.element_token && properties.element_token.type === "string")));
}
function supportsRequiredTools(raw) {
  const schemas = toolSchemas(raw);
  const launch = schemas.get("launch_app");
  const front = schemas.get("bring_to_front");
  return supportsWindowInput(schemas.get("type_text"), "text", true) &&
    supportsWindowInput(schemas.get("press_key"), "key", false) &&
    supportsWindowInput(schemas.get("hotkey"), "keys", false) &&
    supportsWindowInput(schemas.get("scroll"), "direction", true) &&
    Boolean(launch && launch.additionalProperties === false && launch.properties && launch.properties.bundle_id && launch.properties.name) &&
    Boolean(front && front.additionalProperties === false && front.properties && front.properties.pid);
}

function validateAgentSdk(sdk) {
  return Boolean(validateSdk(sdk) &&
    sdk.ListAppsInput && typeof sdk.ListAppsInput.new === "function" &&
    sdk.ClickPosition && sdk.ClickPosition.Coordinates && typeof sdk.ClickPosition.Coordinates.new === "function" &&
    sdk.InputDeliveryMode && sdk.InputDeliveryMode.Foreground !== undefined);
}

function loadPackagedOrInstalledPermissionHelpers() {
  const packagedRoot = typeof process.resourcesPath === "string" ? path.join(process.resourcesPath, "app.asar.unpacked") : "";
  if (process.versions.electron && __dirname.includes("app.asar") && packagedRoot) {
    return import(pathToFileURL(path.join(packagedRoot, "node_modules", "@trycua", "cua-driver", "dist", "electron.js")).href);
  }
  return import("@trycua/cua-driver/electron");
}

/** Maps a thrown driver error to an honest execution status. */
function classifyError(error) {
  if (error && error.code === "native_timeout") return { status: "unknown", code: "timeout" };
  const tag = error && error.tag;
  const inner = error && error.inner;
  if (tag === "Tool") {
    const code = safeCode(inner && inner.errorCode) || "tool_error";
    return { status: "failed", code };
  }
  if (tag === "InvalidArguments" || tag === "Configuration") return { status: "failed", code: "invalid_arguments" };
  return { status: "unknown", code: "driver_error" };
}

const STATUS_MESSAGES = Object.freeze({
  delivered: "已执行",
  unverified: "已发送输入，等待界面验证",
  no_effect: "界面没有变化，可能未生效",
  failed: "未能执行",
  blocked: "未执行",
  unknown: "结果无法确认，不会重复执行",
});

/** Plain-language reason for a refused action; unknown codes stay visible for support. */
const FAILURE_REASONS = Object.freeze({
  background_unavailable: "目标应用不接受后台操作",
  stale_element: "控件已变化",
  element_not_found: "找不到这个控件",
  invalid_arguments: "参数不被接受",
  tool_error: "本机操作被拒绝",
  timeout: "等待超时",
});
function failureMessage(code) {
  if (!code) return STATUS_MESSAGES.failed;
  return `${STATUS_MESSAGES.failed}（${FAILURE_REASONS[code] || `代码 ${code}`}）`;
}

/* ------------------------------------------------------------------ */
/* Controller.                                                         */
/* ------------------------------------------------------------------ */

function createComputerAgentController({
  platform = process.platform,
  arch = process.arch,
  osVersion = "",
  hostPid = process.pid,
  loadSdk = loadPackagedOrInstalledSdk,
  loadPermissionHelpers = loadPackagedOrInstalledPermissionHelpers,
  showConsent = async () => false,
  showExtraConsent = async () => false,
  openPrivacyPane = async () => undefined,
  emit = () => undefined,
  /** Brings 同频 forward again after a run that kept the target app in front. */
  restoreHost = () => undefined,
  /**
   * On-screen windows of `pid` on CGWindow layers other than 0, as raw window
   * records (parseLayeredWindows); null when they could not be listed. Asked
   * only while a search is open, to find a search list the app draws as its
   * own window.
   */
  listPopupWindows = async () => null,
  /**
   * The system's text recognition over one window picture (base64 image):
   * [text, confidence, x, y, width, height] rows with coordinates normalized
   * to the picture (origin at the bottom left, Vision's convention); null
   * when unavailable. Runs on this machine only; the text never leaves it.
   */
  recognizeText = async () => null,
  /** Bundle ids (lower case) of apps that start on the foreground rung. */
  foregroundFirstBundles = FOREGROUND_FIRST_BUNDLES,
  registerStopShortcut = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
  createId = () => randomBytes(16).toString("hex"),
  permissionWaitMs = 120_000,
  permissionPollMs = 1_500,
  timing = TIMING,
} = {}) {
  let sdkPromise = null;
  let run = null;
  let pending = null;
  // Apps (bundle ids) that refused background input in an earlier run of this session.
  const learnedForeground = new Set();
  let shortcutDispose = null;
  let screenRecordingAsked = false;

  async function getSdk() {
    if (!sdkPromise) sdkPromise = Promise.resolve().then(loadSdk);
    let sdk;
    try { sdk = await sdkPromise; } catch (error) { sdkPromise = null; throw error; }
    if (!validateAgentSdk(sdk)) {
      const error = new Error("sdk_api_mismatch");
      error.code = "sdk_api_mismatch";
      throw error;
    }
    return sdk;
  }

  function native(runState, call, timeoutMs = timing.nativeTimeoutMs) {
    return withTimeout((signal) => call(runState.driver, runState.sdk, signal), timeoutMs);
  }

  function armStopShortcut() {
    if (shortcutDispose || typeof registerStopShortcut !== "function") return;
    try {
      const dispose = registerStopShortcut(() => { void stop("esc"); });
      shortcutDispose = typeof dispose === "function" ? dispose : null;
    } catch {
      shortcutDispose = null;
    }
  }
  function disarmStopShortcut() {
    const dispose = shortcutDispose;
    shortcutDispose = null;
    try { dispose?.(); } catch { /* already released */ }
  }

  function readPermissions(sdk) {
    if (platform !== "darwin") return { accessibility: true, screenRecording: true };
    try {
      const status = sdk.currentMacOsPermissionStatus();
      return { accessibility: status && status.accessibility === true, screenRecording: status && status.screenRecording === true };
    } catch {
      return { accessibility: false, screenRecording: false };
    }
  }

  /**
   * After the single consent: request every missing permission together
   * (system prompts), then open the exact System Settings pane for whatever
   * is still missing and wait. Accessibility is required; without Screen
   * Recording the run continues tree-only (no coordinate fallback).
   */
  async function ensurePermissions(sdk, state) {
    let status = readPermissions(sdk);
    if (status.accessibility && status.screenRecording) return { status };
    if (status.accessibility && screenRecordingAsked) {
      // Screen Recording is optional (tree-only fallback). It was requested
      // once in this app session already; do not reopen the pane every run.
      emit({ type: "permission_ready", axOnly: true });
      return { status };
    }
    screenRecordingAsked = true;
    const missing = () => [...(status.accessibility ? [] : ["accessibility"]), ...(status.screenRecording ? [] : ["screenRecording"])];
    emit({ type: "permission_wait", missing: missing() });
    try {
      const helpers = await loadPermissionHelpers();
      helpers?.requestMacOSPermissions?.();
    } catch {
      // The panes below still let the member grant access manually.
    }
    const started = now();
    const opened = new Set();
    let accessibilityReadyAt = null;
    for (;;) {
      if (state.cancelled) return { cancelled: true };
      status = readPermissions(sdk);
      if (status.accessibility && status.screenRecording) break;
      if (status.accessibility && accessibilityReadyAt === null) accessibilityReadyAt = now();
      if (now() - started >= timing.openPaneAfterMs) {
        const pane = !status.accessibility ? "accessibility" : "screenRecording";
        if (!opened.has(pane)) {
          opened.add(pane);
          try { await openPrivacyPane(pane); } catch { /* member can open it manually */ }
        }
      }
      if (now() - started >= permissionWaitMs) break;
      if (accessibilityReadyAt !== null && now() - accessibilityReadyAt >= timing.screenRecordingGraceMs) break;
      await sleep(permissionPollMs);
    }
    if (state.cancelled) return { cancelled: true };
    if (!status.accessibility) return { error: failure("permission_missing") };
    emit({ type: "permission_ready", axOnly: !status.screenRecording });
    return { status };
  }

  async function disposeDriver(state) {
    if (!state || !state.driver) return;
    const { driver, sdk, sessionId } = state;
    state.driver = null;
    if (sessionId) {
      try { await withTimeout((signal) => driver.endSession(sdk.EndSessionInput.new({ session: sessionId }), { signal })); } catch { /* best effort */ }
    }
    try { await withTimeout((signal) => driver.shutdown({ signal })); } catch { /* best effort */ }
    try { driver.uniffiDestroy?.(); } catch { /* best effort */ }
  }

  async function startDriver(sdk) {
    const driver = sdk.CuaDriver.create(undefined);
    const methods = ["metadata", "startSession", "endSession", "listApps", "listWindows", "getWindowState", "click", "listToolsJson", "callTool", "shutdown"];
    if (!driver || methods.some((name) => typeof driver[name] !== "function")) {
      const error = new Error("sdk_api_mismatch");
      error.code = "sdk_api_mismatch";
      throw error;
    }
    const state = { driver, sdk, sessionId: null };
    try {
      const metadata = await withTimeout((signal) => driver.metadata({ signal }), 5_000);
      if (!metadata || metadata.driverVersion !== CUA_DRIVER_VERSION || metadata.embedded !== true) {
        const error = new Error("sdk_version_mismatch");
        error.code = "sdk_version_mismatch";
        throw error;
      }
      const tools = await withTimeout((signal) => driver.listToolsJson({ signal }), 5_000);
      if (!supportsRequiredTools(tools)) {
        const error = new Error("sdk_api_mismatch");
        error.code = "sdk_api_mismatch";
        throw error;
      }
      const sessionId = `tongpin-agent-${createId().slice(0, 16)}`;
      const started = await withTimeout((signal) => driver.startSession(sdk.StartSessionInput.new({ session: sessionId }), { signal }));
      if (!started || started.active !== true) throw new Error("session_start_failed");
      state.sessionId = sessionId;
      return state;
    } catch (error) {
      await disposeDriver(state);
      throw error;
    }
  }

  function parseConsentInput(input) {
    const root = record(input);
    if (!root || !hasOnlyKeys(root, ["runId", "task", "limits"]) || typeof root.runId !== "string" || !RUN_ID.test(root.runId)) return { error: failure("invalid_input") };
    const validation = policy.validateTaskSpec(root.task);
    if (!validation.ok) return { error: failure("invalid_task", validation.message) };
    const limits = policy.validateLimits(root.limits);
    if (!limits) return { error: failure("invalid_input") };
    if (validation.task.apps.some((app) => isBlockedApp(app.name, app.bundleId))) return { error: failure("blocked_app") };
    return { runId: root.runId, task: validation.task, limits };
  }

  async function consent(input) {
    if (run) return failure("run_active");
    if (pending) return failure("busy");
    const parsed = parseConsentInput(input);
    if (parsed.error) return parsed.error;
    const unsupported = probePlatform(platform, arch, osVersion);
    if (unsupported) return failure("unsupported", unsupported.message);
    const state = { cancelled: false };
    pending = state;
    let driverState = null;
    try {
      let sdk;
      try {
        sdk = await withTimeout(() => getSdk(), 5_000);
      } catch (error) {
        return failure(error && error.code === "sdk_api_mismatch" ? "sdk_api_mismatch" : "sdk_unavailable");
      }
      const before = readPermissions(sdk);
      const skipScreenRecording = before.accessibility && !before.screenRecording && screenRecordingAsked;
      const missing = [...(before.accessibility ? [] : ["accessibility"]), ...(before.screenRecording || skipScreenRecording ? [] : ["screenRecording"])];
      const dialog = policy.consentDialog(parsed.task, parsed.limits, { platform, missingPermissions: missing, screenRecordingSkipped: skipScreenRecording });
      let approved = false;
      try { approved = (await showConsent(dialog)) === true; } catch { approved = false; }
      if (!approved || state.cancelled) return failure("consent_denied");

      const permission = await ensurePermissions(sdk, state);
      if (permission.cancelled) return failure("stopped");
      if (permission.error) return permission.error;
      const permissions = permission.status;

      try {
        driverState = await startDriver(sdk);
      } catch (error) {
        const code = error && ["sdk_api_mismatch", "sdk_version_mismatch"].includes(error.code) ? error.code : "session_start_failed";
        return failure(code);
      }
      if (state.cancelled) {
        await disposeDriver(driverState);
        return failure("stopped");
      }
      const current = {
        ...driverState,
        runId: parsed.runId,
        task: parsed.task,
        limits: parsed.limits,
        grantApps: parsed.task.apps,
        permissions,
        axOnly: !permissions.screenRecording,
        startedAt: now(),
        deadline: now() + parsed.limits.maxMinutes * 60_000 + timing.deadlineGraceMs,
        executed: 0,
        targetIndex: 0,
        tracker: policy.emptyTracker(),
        sendBaseline: null,
        screenBaseline: null,
        screenBeforeTyping: null,
        typeCheck: null,
        frontedTarget: false,
        observation: null,
        apps: [],
        busy: false,
        stopped: false,
      };
      run = current;
      driverState = null;
      armStopShortcut();
      let apps = [];
      try { apps = await resolveApps(current); } catch { apps = []; }
      // Esc or Stop may arrive while the app list is read.
      if (current.stopped) return failure("stopped");
      current.apps = apps;
      // Apps known (or learned earlier in this session) to take no background
      // input start on the foreground rung instead of spending steps on misses.
      if (foregroundApp(targetBundle(current))) current.tracker = policy.foregroundFirst(current.tracker);
      return success({
        runId: current.runId,
        platform: platform === "darwin" ? "macos" : "windows",
        permissions: { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording },
        axOnly: current.axOnly,
        apps: current.grantApps.map((grant, index) => ({ name: grant.name, running: Boolean(apps[index] && apps[index].running) })),
      });
    } finally {
      if (driverState) await disposeDriver(driverState);
      if (pending === state) pending = null;
    }
  }

  /** Granted apps resolved against the live app list (never the host). */
  async function resolveApps(state) {
    const output = await native(state, (driver, sdk, signal) => driver.listApps(sdk.ListAppsInput.new({}), { signal }));
    const infos = (output && Array.isArray(output.apps) ? output.apps : [])
      .filter((info) => info && typeof info.name === "string")
      .map((info) => ({
        pid: Number.isInteger(info.pid) && info.pid > 0 ? info.pid : 0,
        name: safeText(info.name, 120),
        bundleId: typeof info.bundleId === "string" ? safeText(info.bundleId, 150) : "",
        running: info.running === true && Number.isInteger(info.pid) && info.pid > 0,
      }))
      .filter((info) => info.pid !== hostPid && !isBlockedApp(info.name, info.bundleId));
    return state.grantApps.map((grant, index) => {
      const matches = infos.filter((info) => appMatches(grant, info));
      const info = matches.find((item) => item.running) || matches[0] || null;
      return {
        index,
        name: grant.name,
        pid: info && info.running ? info.pid : 0,
        running: Boolean(info && info.running),
        installed: Boolean(info),
        bundleId: (info && info.bundleId) || grant.bundleId || "",
        launchName: (info && info.name) || grant.name,
      };
    });
  }

  async function listAppWindows(state, app) {
    if (!app.running || !app.pid) return [];
    const output = await native(state, (driver, sdk, signal) => driver.listWindows(sdk.ListWindowsInput.new({ pid: app.pid }), { signal }));
    return (output && Array.isArray(output.windows) ? output.windows : [])
      .map((window) => normalizeWindowInfo(window, hostPid))
      .filter((window) => window && window.pid === app.pid)
      .slice(0, 50);
  }

  async function capture(state, target, withScreenshot) {
    const output = await native(state, (driver, sdk, signal) => driver.getWindowState(sdk.GetWindowStateInput.new({
      pid: target.pid,
      windowId: BigInt(target.windowId),
      session: state.sessionId,
      includeAccessibilityTree: true,
      includeScreenshot: withScreenshot,
      maxElements: CAPTURE.maxElements,
      maxDepth: CAPTURE.maxDepth,
      ...(withScreenshot ? { maxDimension: CAPTURE.maxDimension } : {}),
    }), { signal }));
    return normalizeState(output, target);
  }

  /**
   * One attached window, read only: its tree (often empty — Cua cannot always
   * tie such a window to an accessibility window) and, with Screen Recording,
   * a hash of a small picture so a redraw can be told from no change. Never
   * fails the observation.
   */
  async function capturePopup(state, window) {
    const withShot = state.permissions.screenRecording === true;
    try {
      const output = await native(state, (driver, sdk, signal) => driver.getWindowState(sdk.GetWindowStateInput.new({
        pid: window.pid,
        windowId: BigInt(window.windowId),
        session: state.sessionId,
        includeAccessibilityTree: true,
        includeScreenshot: withShot,
        maxElements: POPUP_CAPTURE.maxElements,
        maxDepth: POPUP_CAPTURE.maxDepth,
        ...(withShot ? { maxDimension: POPUP_CAPTURE.maxDimension } : {}),
      }), { signal }));
      const snapshot = normalizeState(output, { pid: window.pid, windowId: window.windowId, title: window.title, bounds: window.bounds });
      if (!snapshot) return null;
      const image = withShot && Array.isArray(output.images) && output.images[0] && typeof output.images[0].dataBase64 === "string" && output.images[0].dataBase64
        ? output.images[0].dataBase64
        : null;
      return {
        windowId: window.windowId,
        bounds: window.bounds,
        read: true,
        elements: snapshot.elements.slice(0, POPUP_CAPTURE.maxElements),
        windowBounds: snapshot.windowBounds,
        treeMarkdown: snapshot.treeMarkdown,
        hash: image ? createHash("sha256").update(image).digest("hex") : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The target window's visible text, read on this machine by the system's
   * text recognition, as lines in window-local points (top-left origin).
   * Null without Screen Recording, without a recognizer or on any failure:
   * the run then relies on the accessibility tree alone.
   */
  async function readScreenText(state, target) {
    if (!target || state.permissions.screenRecording !== true) return null;
    try {
      const output = await native(state, (driver, sdk, signal) => driver.getWindowState(sdk.GetWindowStateInput.new({
        pid: target.pid,
        windowId: BigInt(target.windowId),
        session: state.sessionId,
        includeAccessibilityTree: false,
        includeScreenshot: true,
        maxDimension: SCREEN_TEXT.maxDimension,
      }), { signal }));
      // Only a picture of exactly the window maps onto window coordinates.
      if (!output || output.pid !== target.pid || bigString(output.windowId) !== target.windowId || output.screenshotFrameValid !== true) return null;
      const image = Array.isArray(output.images) && output.images[0] && typeof output.images[0].dataBase64 === "string" ? output.images[0].dataBase64 : "";
      const bounds = normalizeBounds(output.windowBounds) || target.bounds;
      if (!image || !bounds || state.stopped) return null;
      const rows = await recognizeText(image);
      if (!Array.isArray(rows) || state.stopped) return null;
      const lines = [];
      for (const row of rows.slice(0, SCREEN_TEXT.maxLines)) {
        if (!Array.isArray(row)) continue;
        const [text, confidence, nx, ny, nw, nh] = row;
        const clean = safeText(text, SCREEN_TEXT.maxLineChars);
        if (!clean || ![nx, ny, nw, nh].every(finite) || !(nw > 0 && nh > 0) || !finite(confidence) || confidence < 0.5) continue;
        lines.push({ text: clean, x: nx * bounds.width, y: (1 - ny - nh) * bounds.height, w: nw * bounds.width, h: nh * bounds.height });
      }
      return { lines, windowBounds: bounds };
    } catch {
      return null;
    }
  }

  function sendTask(state) {
    return Boolean(state.task.irreversible && state.task.irreversible.kind === "send_message");
  }

  /**
   * Same-app windows floating over the target: Cua's layer-0 windows plus the
   * host's listing of the other layers. `looked` is false when the host could
   * not list them, so "no list" is never mistaken for "could not look".
   */
  async function floatingWindows(state, chosenWindow, windows) {
    let layered = null;
    try { layered = await listPopupWindows(chosenWindow.pid); } catch { layered = null; }
    if (!Array.isArray(layered)) return { looked: false, windows: attachedWindows(windows, chosenWindow) };
    const extra = layered.slice(0, 20)
      .map((raw) => normalizeWindowInfo(raw, hostPid))
      .filter((window) => window && window.pid === chosenWindow.pid && window.layer !== 0);
    return { looked: true, windows: attachedWindows([...windows, ...extra], chosenWindow) };
  }

  /**
   * Reads the floating windows (read only) and which of them is the target's
   * search list (from where it hangs in `windowBounds`). A window whose read
   * fails still counts by its position, with no picture.
   */
  async function readFloating(state, floating, elements, windowBounds) {
    const popups = [];
    for (const window of floating.windows) {
      const popup = await capturePopup(state, window);
      if (state.stopped) return null;
      popups.push(popup || { windowId: window.windowId, bounds: window.bounds, read: false, elements: [], windowBounds: window.bounds, treeMarkdown: "", hash: null });
    }
    // Rows are shown to Jev and, for the search list only, read by the landing
    // check: no candidate is built from them (no token) and they never count
    // as evidence of the open chat, the recipient or a sent message.
    const popupElements = [];
    for (const popup of popups) {
      for (const element of policy.modelElements(popup.elements, popup.windowBounds, elements.length + popupElements.length)) {
        popupElements.push({ ...element, token: null, popup: true, popupWindowId: popup.windowId });
      }
    }
    const searchList = policy.searchListState({ looked: floating.looked, windowBounds, popups });
    const listIds = new Set(searchList.lists.map((list) => list.windowId));
    return { popups, popupElements, searchList, searchRows: popupElements.filter((element) => listIds.has(element.popupWindowId)) };
  }

  /** The search lists now, for the window and search box of `observation`. */
  async function readSearchLists(state, observation, elements) {
    if (!observation.target || !observation.chosenWindow) return null;
    try {
      const windows = await listAppWindows(state, { running: true, pid: observation.target.pid });
      if (state.stopped) return null;
      // The target window as it is now (it may have moved since the capture).
      const chosen = windows.find((window) => window.windowId === observation.chosenWindow.windowId) || observation.chosenWindow;
      const floating = await floatingWindows(state, chosen, windows);
      if (state.stopped) return null;
      return await readFloating(state, floating, elements, chosen.bounds);
    } catch {
      return null;
    }
  }

  /** A search is open (or its proof must be re-checked): look for its list. */
  function searchOpen(state) {
    const tracker = state.tracker;
    return tracker.focus === "search" || Boolean(state.typeCheck && state.typeCheck.field === "search") ||
      Boolean(tracker.searchSeen && tracker.searchSeen === tracker.searchText);
  }

  function activeRun() {
    return run && !run.stopped ? run : null;
  }

  async function enforceLimits(state) {
    if (now() > state.deadline) { await stop("limit"); return failure("time_limit"); }
    return null;
  }

  async function observe() {
    const state = activeRun();
    if (!state) return failure("session_not_active");
    if (state.busy) return failure("busy");
    const limited = await enforceLimits(state);
    if (limited) return limited;
    state.busy = true;
    try {
      const apps = await resolveApps(state);
      if (state.stopped) return failure("stopped");
      state.apps = apps;
      const targetApp = apps[state.targetIndex] || apps[0];
      let target = null;
      let hiddenWindow = null;
      let chosenWindow = null;
      let floating = { looked: false, windows: [] };
      if (targetApp && targetApp.running) {
        const windows = await listAppWindows(state, targetApp);
        const chosen = chooseWindow(windows);
        if (chosen && !chosen.hidden) {
          target = { app: targetApp.name, pid: chosen.window.pid, windowId: chosen.window.windowId, title: chosen.window.title, bounds: chosen.window.bounds, running: true, minimized: false };
          chosenWindow = chosen.window;
          // A search list is usually drawn on a layer Cua does not list; look
          // for floating windows only while a search is open (a script run).
          if (searchOpen(state)) {
            floating = await floatingWindows(state, chosen.window, windows);
            if (state.stopped) return failure("stopped");
          }
        } else if (chosen) {
          hiddenWindow = chosen.window;
        }
      }
      if (targetApp) targetApp.hiddenWindowId = hiddenWindow ? hiddenWindow.windowId : null;
      let snapshot = null;
      let screenshotUsed = false;
      if (target) {
        // After a background refusal, foreground position clicks need the
        // window's pixel geometry, so capture it with the tree in one call.
        const foreground = state.tracker.delivery === "foreground" && state.permissions.screenRecording;
        snapshot = await capture(state, target, foreground);
        if (foreground && snapshot) screenshotUsed = true;
        if (snapshot && !foreground && isSparse(snapshot.elements) && state.permissions.screenRecording) {
          const withShot = await capture(state, target, true);
          if (withShot) { snapshot = withShot; screenshotUsed = true; }
        }
        if (!snapshot) return failure("observe_failed");
      }
      if (state.stopped) return failure("stopped");
      const axSparse = snapshot ? isSparse(snapshot.elements) : false;
      const windowBounds = snapshot ? snapshot.windowBounds : null;
      const elements = snapshot ? policy.modelElements(snapshot.elements, windowBounds) : [];
      const listBounds = chosenWindow ? chosenWindow.bounds : null;
      const read = snapshot && floating.windows.length
        ? await readFloating(state, floating, elements, listBounds)
        : { popups: [], popupElements: [], searchList: policy.searchListState({ looked: floating.looked, windowBounds: listBounds, popups: [] }), searchRows: [] };
      if (!read || state.stopped) return failure("stopped");
      const { popups, popupElements, searchList, searchRows } = read;
      const landingElements = policy.landingView(elements, searchRows);
      // Text typed "into focus" is checked on each capture until it is seen
      // (at most TYPE_CHECK_LOOKS captures; a slow app may render it late).
      // Seen only in the wrong kind of input box means focus was not where the
      // run believed: no further typing, Return or send is offered.
      let landing = null;
      if (state.typeCheck && snapshot) {
        const check = state.typeCheck;
        check.looks += 1;
        const detail = policy.typedLandingDetail(check, landingElements, searchList);
        landing = { field: check.field, text: check.text, landed: detail.landed };
        if (landing.landed !== "unknown" || check.looks >= TYPE_CHECK_LOOKS) state.typeCheck = null;
        if (landing.landed === "elsewhere") {
          state.tracker = Object.freeze({ ...state.tracker, misdirected: true, focus: "none", searchText: null, composerText: null });
        } else if (landing.landed === "expected" && check.field === "search" && state.tracker.focus === "search" && state.tracker.searchText === check.text) {
          // The keystrokes reached the search box: Return may open its result.
          state.tracker = Object.freeze({ ...state.tracker, searchSeen: check.text, searchSeenBy: detail.by, searchResultsBase: detail.by === "results" ? (check.before.results || 0) : null });
        }
      }
      // The proof must still stand in this capture: a search list that closed
      // or results or text that disappeared mean the search box lost focus.
      const proof = snapshot ? policy.searchProof(state.tracker, landingElements, searchList) : "unknown";
      if (proof === "gone") state.tracker = policy.withdrawSearch(state.tracker);
      const treeTexts = snapshot ? policy.extractTreeTexts(snapshot.treeMarkdown) : [];
      const windowTitle = snapshot ? snapshot.windowTitle : null;
      const appName = targetApp ? targetApp.name : state.grantApps[0].name;
      const appStates = apps.map((app) => ({
        name: app.name,
        running: app.running,
        hasWindow: Boolean(app.running && (app.index === state.targetIndex ? target : true)),
      }));
      const candidates = policy.buildCandidates({
        platform,
        task: state.task,
        target: target ? { app: appName, pid: target.pid, windowId: target.windowId, title: windowTitle, running: true, minimized: false } : null,
        appStates,
        elements,
        axSparse,
        screenshot: screenshotUsed && snapshot.screenshot ? snapshot.screenshot : null,
        windowBounds,
        tracker: state.tracker,
        searchProof: proof,
        canLaunch: true,
      });
      const observationId = `ob_${createId().slice(0, 24)}`;
      state.observation = {
        id: observationId,
        capturedAt: now(),
        target,
        appAllowed: Boolean(target),
        elements,
        treeTexts,
        chosenWindow,
        popupElements,
        searchList,
        searchRows,
        windowTitle,
        fingerprint: snapshot ? semanticFingerprint(snapshot) : null,
        candidates: new Map(candidates.map((candidate) => [candidate.id, candidate])),
      };
      const popupTexts = popups.flatMap((popup) => policy.extractTreeTexts(popup.treeMarkdown, POPUP_CAPTURE.maxTexts));
      const observation = policy.projectObservation({
        app: appName, windowTitle, axSparse, task: state.task,
        elements: popupElements.length ? [...elements, ...popupElements] : elements,
        treeTexts: popupTexts.length ? [...treeTexts, ...popupTexts] : treeTexts,
      });
      const targetWindow = target ? "visible" : targetApp && targetApp.running ? "hidden" : "none";
      // Around a send the window's text is read on this machine: before it,
      // whether the open chat and the composer are the granted ones; after
      // it, whether a new copy appeared and the composer emptied.
      const tracker = state.tracker;
      const aroundSend = sendTask(state) && (tracker.sendCount > 0 ? Boolean(state.screenBaseline) : Boolean(tracker.conversationTarget || tracker.composerText));
      const screenRead = target && aroundSend ? await readScreenText(state, target) : null;
      if (state.stopped) return failure("stopped");
      // Lines read after the chat opened and before the run typed its text:
      // what was already on screen (old bubbles, a draft) is told apart from
      // the line the typing brought up.
      if (screenRead && tracker.sendCount === 0 && tracker.composerText === null) state.screenBeforeTyping = screenRead;
      const screen = screenRead ? policy.screenSendFacts({
        task: state.task, screen: screenRead, windowBounds: screenRead.windowBounds, elements,
        before: state.screenBeforeTyping, composerAt: tracker.sendCount > 0 ? state.screenBaseline.composerLine : null,
      }) : null;
      state.observation.screen = screen;
      const facts = policy.facts({ tracker: state.tracker, task: state.task, observation: { elements, treeTexts }, sendBaseline: state.sendBaseline, appName, appRunning: Boolean(targetApp && targetApp.running), targetWindow, landing, searchListShown: searchList.lists.length > 0, screen, screenBaseline: state.screenBaseline });
      return success({
        observationId,
        observation,
        candidates: candidates.map(policy.publicCandidate),
        facts,
        display: {
          app: appName, title: windowTitle, elementCount: elements.length, axSparse, screenshotUsed,
          ...(popups.length ? { popupCount: popups.length, popupElementCount: popupElements.length, floating: policy.floatingGeometry(listBounds, popups, searchList.lists, elements) } : {}),
          ...(searchList.lists.length ? { searchListShown: true } : {}),
          ...(screen ? { screenText: { phase: tracker.sendCount > 0 ? "after" : "before", recipientInTitle: screen.recipientInTitle, composerHoldsText: Boolean(screen.anchored && screen.composerLine), copies: screen.copies } } : {}),
        },
      });
    } catch {
      return failure("observe_failed");
    } finally {
      state.busy = false;
    }
  }

  function effectStatus(sdk, effect) {
    if (effect === undefined || effect === null) return "unverified";
    if (effect === sdk.ActionEffect.Confirmed) return "delivered";
    if (effect === sdk.ActionEffect.Partial || effect === sdk.ActionEffect.Unverifiable) return "unverified";
    if (effect === sdk.ActionEffect.SuspectedNoop) return "no_effect";
    if (effect === sdk.ActionEffect.Refused) return "failed";
    return "unknown";
  }
  function toolStatus(sdk, result, { actionExpected = true } = {}) {
    if (!result || typeof result !== "object") return { status: "unknown", code: "no_result" };
    if (result.isError === true) return { status: "failed", code: safeCode(result.errorCode) || "tool_error" };
    if (result.isError !== false) return { status: "unknown", code: "no_result" };
    if (!result.action) return { status: actionExpected ? "unverified" : "delivered" };
    return { status: effectStatus(sdk, result.action.effect) };
  }

  async function activateApp(state, candidate) {
    const app = state.apps[candidate.appIndex];
    const grant = state.grantApps[candidate.appIndex];
    if (!app || !grant) return { status: "blocked", code: "app_not_granted" };
    if (candidate.launch === "switch") {
      state.targetIndex = candidate.appIndex;
      return { status: "delivered" };
    }
    if (isBlockedApp(app.launchName, app.bundleId)) return { status: "blocked", code: "blocked_app" };
    const args = app.bundleId && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(app.bundleId)
      ? `{"bundle_id":${JSON.stringify(app.bundleId)}}`
      : `{"name":${JSON.stringify(app.launchName)}}`;
    const launched = toolStatus(state.sdk, await native(state, (driver, _sdk, signal) => driver.callTool("launch_app", args, { signal }), timing.launchTimeoutMs), { actionExpected: false });
    if (launched.status === "failed" || launched.status === "unknown") return launched;
    if (candidate.launch === "front" && app.pid && app.hiddenWindowId) {
      try {
        await native(state, (driver, _sdk, signal) => driver.callTool("bring_to_front", `{"pid":${app.pid},"window_id":${app.hiddenWindowId}}`, { signal }));
      } catch { /* the reopened app usually shows its main window anyway */ }
    }
    state.targetIndex = candidate.appIndex;
    await sleep(timing.launchSettleMs);
    return { status: "unverified" };
  }

  /** Persistently fronts the target window (Cua bring_to_front); best effort. */
  async function keepInFront(state, target) {
    try {
      const result = await native(state, (driver, _sdk, signal) => driver.callTool("bring_to_front", `{"pid":${target.pid},"window_id":${target.windowId}}`, { signal }));
      if (result && result.isError !== true) state.frontedTarget = true;
    } catch {
      // The action's own foreground rung still fronts the window briefly.
    }
  }

  async function dispatch(state, candidate, target, elementToken) {
    const sdk = state.sdk;
    const delivery = candidate.delivery === "foreground" ? "foreground" : "background";
    switch (candidate.kind) {
      case "activate_app":
        return activateApp(state, candidate);
      case "click": {
        const result = await native(state, (driver, _sdk, signal) => driver.click(sdk.ClickInput.new({
          target: sdk.ActionTarget.Window.new({ pid: target.pid, windowId: BigInt(target.windowId) }),
          position: sdk.ClickPosition.Element.new({ elementToken }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          session: state.sessionId,
          button: sdk.ClickButton.Left,
          count: 1,
        }), { signal }));
        return { status: effectStatus(sdk, result && result.effect) };
      }
      case "point": {
        const result = await native(state, (driver, _sdk, signal) => driver.click(sdk.ClickInput.new({
          target: sdk.ActionTarget.Window.new({ pid: target.pid, windowId: BigInt(target.windowId) }),
          position: sdk.ClickPosition.Coordinates.new({ x: candidate.point.x, y: candidate.point.y }),
          deliveryMode: delivery === "foreground" ? sdk.InputDeliveryMode.Foreground : sdk.InputDeliveryMode.Background,
          session: state.sessionId,
          button: sdk.ClickButton.Left,
          count: 1,
        }), { signal }));
        return { status: effectStatus(sdk, result && result.effect) };
      }
      case "type": {
        const fields = elementToken ? { text: candidate.text, element_token: elementToken } : { text: candidate.text };
        const result = await native(state, (driver, _sdk, signal) => driver.callTool("type_text", toolJson(fields, target, state.sessionId, elementToken ? "background" : delivery), { signal }));
        return toolStatus(sdk, result);
      }
      case "key": {
        const result = await native(state, (driver, _sdk, signal) => driver.callTool("press_key", toolJson({ key: candidate.key }, target, state.sessionId, delivery), { signal }));
        return toolStatus(sdk, result);
      }
      case "hotkey": {
        const result = await native(state, (driver, _sdk, signal) => driver.callTool("hotkey", toolJson({ keys: [...candidate.keys] }, target, state.sessionId, delivery), { signal }));
        return toolStatus(sdk, result);
      }
      case "scroll": {
        const result = await native(state, (driver, _sdk, signal) => driver.callTool("scroll", toolJson({ direction: candidate.direction, by: "line", amount: 3, element_token: elementToken }, target, state.sessionId, "background"), { signal }));
        return toolStatus(sdk, result);
      }
      default:
        return { status: "blocked", code: "unsupported_candidate" };
    }
  }

  function outcome(status, extra = {}) {
    return { status, message: extra.message || STATUS_MESSAGES[status] || "未执行", authorization: extra.authorization || "allowed", ...(extra.code ? { code: extra.code } : {}), ...(extra.delivery ? { delivery: extra.delivery } : {}) };
  }

  async function execute(input) {
    const state = activeRun();
    if (!state) return failure("session_not_active");
    const root = record(input);
    if (!root || !hasOnlyKeys(root, ["observationId", "candidateId"]) ||
      typeof root.observationId !== "string" || !OBSERVATION_ID.test(root.observationId) ||
      typeof root.candidateId !== "string" || !CANDIDATE_ID.test(root.candidateId)) return failure("invalid_input");
    if (state.busy) return failure("busy");
    const observation = state.observation;
    if (!observation || observation.id !== root.observationId || now() - observation.capturedAt > timing.observationTtlMs) return failure("observation_stale");
    const candidate = observation.candidates.get(root.candidateId);
    if (!candidate) return failure("candidate_unknown");
    if (candidate.kind === "reserved") return failure("invalid_input", "保留选项不执行动作");
    const limited = await enforceLimits(state);
    if (limited) return limited;
    if (state.executed >= state.limits.maxSteps) { await stop("limit"); return failure("step_limit"); }
    // Each observation authorizes at most one execution attempt.
    state.observation = null;
    state.busy = true;
    try {
      return success(await executeCandidate(state, candidate, observation));
    } finally {
      state.busy = false;
    }
  }

  async function executeCandidate(state, candidate, observation) {
    const task = state.task;
    const delivery = candidate.delivery === "foreground" ? "foreground" : "background";
    const authObservation = { appAllowed: observation.appAllowed, elements: observation.elements, windowTitle: observation.windowTitle, treeTexts: observation.treeTexts, screen: observation.screen || null };
    let decision = policy.authorizeCandidate(candidate, { task, tracker: state.tracker, observation: authObservation, grantApps: state.grantApps });
    let authorization = "allowed";
    /** One more native confirmation; null when granted, else the blocked outcome. */
    const confirmNatively = async (extra) => {
      emit({ type: "extra_consent", summary: extra.summary });
      let approved = false;
      try { approved = (await showExtraConsent(policy.extraConsentDialog(candidate, extra))) === true; } catch { approved = false; }
      if (!approved) {
        await stop("user");
        return outcome("blocked", { authorization: "extra_consent", code: "extra_consent_denied", message: "你没有允许这一步，电脑操作已停止" });
      }
      if (state.stopped) return outcome("blocked", { authorization: "extra_consent", code: "stopped", message: SAFE_MESSAGES.stopped });
      authorization = "extra_consent";
      return null;
    };
    if (!decision.allowed && decision.extraConsent) {
      const refused = await confirmNatively(decision.extraConsent);
      if (refused) return refused;
      decision = { allowed: true };
    }
    if (!decision.allowed) return outcome("blocked", { authorization: "denied", code: "authorization_denied", message: decision.reason || "这一步不在本次授权范围内" });

    const target = observation.target;
    let elementToken = candidate.elementToken || null;
    if (candidate.kind !== "activate_app") {
      if (!target) return outcome("blocked", { authorization, code: "target_missing", message: "目标窗口不存在，未执行" });
      if (candidate.risk !== "none") {
        // An irreversible step is checked again on a fresh capture: the screen
        // may have changed while Jev decided or while a dialog was open.
        const fresh = await capture(state, target, false).catch(() => null);
        if (!fresh || state.stopped) return outcome("blocked", { authorization, code: "target_changed", message: "界面已变化，未执行这一步" });
        const freshElements = policy.modelElements(fresh.elements, fresh.windowBounds);
        const freshTexts = policy.extractTreeTexts(fresh.treeMarkdown);
        // The send is checked against the window's text as it is right now,
        // which is also the baseline its result is measured against.
        const freshRead = candidate.risk === "send" && sendTask(state) ? await readScreenText(state, target) : null;
        if (state.stopped) return outcome("blocked", { authorization, code: "stopped", message: SAFE_MESSAGES.stopped });
        const freshScreen = freshRead ? policy.screenSendFacts({ task, screen: freshRead, windowBounds: freshRead.windowBounds, elements: freshElements, before: state.screenBeforeTyping }) : null;
        if (candidate.elementIdentity) {
          const matches = freshElements.filter((element) => element.identity === candidate.elementIdentity && element.token);
          if (matches.length !== 1) return outcome("blocked", { authorization, code: "target_changed", message: "要操作的控件已变化，未执行这一步" });
          elementToken = matches[0].token;
        }
        if (authorization === "allowed") {
          const again = policy.authorizeCandidate(candidate, { task, tracker: state.tracker, observation: { appAllowed: true, elements: freshElements, windowTitle: fresh.windowTitle, treeTexts: freshTexts, screen: freshScreen }, grantApps: state.grantApps });
          // What the fresh capture no longer proves by itself (a screen read
          // that failed this time) goes to the member natively, as it would have.
          if (!again.allowed && again.extraConsent) {
            const refused = await confirmNatively(again.extraConsent);
            if (refused) return refused;
          } else if (!again.allowed) {
            return outcome("blocked", { authorization: "denied", code: "authorization_changed", message: again.reason || "界面已变化，未执行这一步" });
          }
        }
        const content = task.irreversible && task.irreversible.content;
        if (candidate.risk === "send" && content) {
          state.sendBaseline = policy.sentTextCount(freshElements, content);
          // Measured on screen only when the composer line itself was seen.
          state.screenBaseline = freshScreen && freshScreen.composerLine ? freshScreen : null;
        }
      }
    }

    // Cua's foreground rung fronts the window for one action and then gives
    // the screen back to the previous app. Apps such as WeChat close their
    // search box when they lose the front, so ⌘F, the typed search and Return
    // would each land in a fresh window. Foreground steps therefore keep the
    // target in front for the rest of the run; stop() hands it back.
    if (delivery === "foreground" && target && ["key", "hotkey", "type", "point"].includes(candidate.kind)) {
      await keepInFront(state, target);
    }

    // Return "opens the search result" only while the search proof still
    // stands right now: Jev decides for seconds, and a search box that lost
    // focus meanwhile (WeChat closes it when it loses the front) would leave
    // Return to a message box that may send whatever it holds.
    if (candidate.kind === "key" && candidate.key === "return" && candidate.risk === "none" && state.tracker.focus === "search" && target) {
      const fresh = await capture(state, target, false).catch(() => null);
      if (!fresh || state.stopped) return outcome("blocked", { authorization, code: "target_changed", message: "界面已变化，未执行这一步" });
      const freshElements = policy.modelElements(fresh.elements, fresh.windowBounds);
      const lists = state.tracker.searchSeenBy === "list" || state.tracker.searchSeenBy === "results"
        ? await readSearchLists(state, observation, freshElements)
        : null;
      if (state.stopped) return outcome("blocked", { authorization, code: "stopped", message: SAFE_MESSAGES.stopped });
      const text = policy.normalizeName(state.tracker.searchText);
      const valueHolds = Boolean(text) && freshElements.some((element) => element.searchLike && policy.normalizeName(element.value) === text);
      const proof = policy.searchProof(state.tracker, policy.landingView(freshElements, lists ? lists.searchRows : []), lists ? lists.searchList : null);
      if (!valueHolds && proof !== "holds") {
        if (proof === "gone") state.tracker = policy.withdrawSearch(state.tracker);
        return outcome("blocked", { authorization, code: "search_closed", message: "搜索结果已经看不到了（搜索可能已关闭），没有按回车" });
      }
    }

    // Typing "into focus" is checked on later captures against the input
    // boxes that already held the literal (see policy.typedLanding). For a
    // search, the list under the box is looked at again right before the
    // keystrokes: a redraw is judged against that, not against an
    // observation that may be many seconds old.
    let typeCheck = null;
    if (candidate.kind === "type" && !elementToken) {
      let beforeList = null;
      let beforeRows = [];
      if (candidate.field === "search") {
        const lists = await readSearchLists(state, observation, observation.elements);
        if (state.stopped) return outcome("blocked", { authorization, code: "stopped", message: SAFE_MESSAGES.stopped });
        if (lists) { beforeList = lists.searchList; beforeRows = lists.searchRows; }
      }
      typeCheck = {
        field: candidate.field, text: candidate.text, looks: 0,
        before: policy.typedTextSpots(policy.landingView(observation.elements, beforeRows), candidate.text),
        beforeList,
        // The list's rows are compared only when this look read every list.
        rowsRead: Boolean(beforeList && beforeList.looked && beforeList.lists.every((list) => list.read)),
      };
    }
    const suspendEsc = candidate.kind === "key" && candidate.key === "escape";
    if (suspendEsc) disarmStopShortcut();
    let result;
    try {
      state.executed += 1;
      result = await dispatch(state, candidate, target, elementToken);
    } catch (error) {
      result = classifyError(error);
    } finally {
      if (suspendEsc && activeRun() === state) armStopShortcut();
    }
    if (state.stopped) {
      return outcome(result.status === "failed" ? "failed" : "unknown", { authorization, code: "stopped", delivery, message: "电脑操作已停止；最后一步的结果无法确认" });
    }

    let status = result.status;
    if (candidate.kind !== "activate_app" && status !== "blocked") await sleep(timing.settleMs);
    // Background keyboard input can be silently ignored by apps that need to
    // be frontmost. A tree that did not change at all is treated as no effect,
    // which makes the policy offer distinct foreground candidates next time.
    if (status === "unverified" && candidate.risk === "none" && delivery === "background" &&
      ["key", "hotkey", "type", "point"].includes(candidate.kind) && target && observation.fingerprint && !state.stopped) {
      const after = await capture(state, target, false).catch(() => null);
      if (after && semanticFingerprint(after) === observation.fingerprint) status = "no_effect";
    }
    // A click on the granted recipient is confirmed only when the clicked row
    // newly shows as selected; otherwise the open conversation stays unknown.
    if (status === "unverified" && candidate.matchesRecipient && (candidate.kind === "click" || candidate.kind === "point") && target && !state.stopped) {
      const after = await capture(state, target, false).catch(() => null);
      if (after && policy.recipientNewlySelected(observation.elements, policy.modelElements(after.elements, after.windowBounds), task, candidate.targetFrame)) status = "delivered";
    }
    state.tracker = policy.nextTracker(state.tracker, candidate, status, { task });
    // Another app starts on its own rung: the foreground one when it needs it.
    if (candidate.kind === "activate_app" && foregroundApp(targetBundle(state))) state.tracker = policy.foregroundFirst(state.tracker);
    // Cua refuses every element-addressed background action on an app whose
    // accessibility nodes it cannot tie to the window; stop offering them,
    // and start this app's next run in the foreground.
    if (status === "failed" && result.code === "element_outside_target_window" && !state.tracker.elementsRefused) {
      state.tracker = Object.freeze({ ...state.tracker, elementsRefused: true });
      const bundle = targetBundle(state);
      if (bundle) learnedForeground.add(bundle);
    }
    // Anything but a clean refusal may have typed somewhere: arm the check.
    if (typeCheck && status !== "failed" && status !== "blocked") state.typeCheck = typeCheck;
    const code = result.code || undefined;
    const escalates = delivery === "background" && candidate.risk === "none" && candidate.kind !== "activate_app";
    const message = code === "background_unavailable"
      ? "目标应用不接受后台输入，下一步可改用前台输入"
      : status === "no_effect" && escalates
        ? "界面没有变化，下一步可改用前台输入"
        : status === "failed" && escalates
          ? `${failureMessage(code)}，下一步可改用前台操作`
          : status === "failed" ? failureMessage(code) : STATUS_MESSAGES[status] || "未执行";
    return outcome(status, { authorization, code, delivery, message });
  }

  function foregroundApp(bundle) {
    return Boolean(bundle) && (foregroundFirstBundles.has(bundle) || learnedForeground.has(bundle));
  }

  function targetBundle(state) {
    const app = (state.apps && state.apps[state.targetIndex]) || null;
    return String((app && app.bundleId) || (state.grantApps[0] && state.grantApps[0].bundleId) || "").toLowerCase();
  }

  async function stop(reason = "user") {
    const safeReason = ["esc", "user", "limit", "window_closed", "logout"].includes(reason) ? reason : "user";
    if (pending) pending.cancelled = true;
    const current = run;
    run = null;
    disarmStopShortcut();
    if (!current) return success({ stopped: true });
    current.stopped = true;
    current.observation = null;
    await disposeDriver(current);
    // The run kept the target app in front; give the screen back to 同频.
    if (current.frontedTarget) {
      try { restoreHost(); } catch { /* the member can switch back themselves */ }
    }
    emit({ type: "stopped", reason: safeReason });
    return success({ stopped: true });
  }

  return Object.freeze({
    consent,
    observe,
    execute,
    stop,
    shutdown: () => stop("window_closed"),
    isActive: () => Boolean(run || pending),
  });
}

module.exports = {
  APP_ALIASES,
  BLOCKED_APPS,
  TIMING,
  appMatches,
  attachedWindows,
  chooseWindow,
  parseLayeredWindows,
  parseRecognizedText,
  classifyError,
  createComputerAgentController,
  isBlockedApp,
  normalizeElement,
  normalizeState,
  normalizeWindowInfo,
  supportsRequiredTools,
  toolJson,
};
