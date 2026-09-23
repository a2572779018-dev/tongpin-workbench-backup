const { createHash, randomBytes, randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CUA_DRIVER_VERSION = "0.28.1";
const APPROVAL_TTL_MS = 30_000;
const SNAPSHOT_TTL_MS = 60_000;
const NATIVE_CALL_TIMEOUT_MS = 8_000;
const SESSION_MAX_ACTIONS = 6;
const SESSION_MAX_DURATION_MS = 5 * 60_000;
const MAX_WINDOWS = 200;
const MAX_TEXT_LENGTH = 200;
const MAX_WINDOW_LABEL_LENGTH = 160;
const MAX_ELEMENT_TEXT_LENGTH = 512;
const MAX_TREE_MARKDOWN_LENGTH = 64 * 1024;
const MAX_SCREENSHOT_BASE64_LENGTH = 8 * 1024 * 1024;
const SNAPSHOT_MAX_ELEMENTS = 160;
const SNAPSHOT_MAX_DEPTH = 12;
const SNAPSHOT_MAX_DIMENSION = 1280;

function computerUseSystemVersion() {
  if (!process.versions.electron) {
    // Ordinary Node tests/tools do not know the macOS product version. In
    // particular os.release() is Darwin's kernel version, not macOS. Returning
    // unknown fails the macOS capability gate closed; callers that test the
    // controller directly must provide an explicit product-version fixture.
    return "";
  }
  if (typeof process.getSystemVersion !== "function") {
    throw new Error("当前 Electron 运行时无法读取系统版本，请重新启动同频后重试");
  }
  return process.getSystemVersion();
}
const MAX_WINDOW_ID = (1n << 64n) - 1n;
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
const SAFE_KEYS = new Set(["escape", "up", "down", "left", "right"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

const SAFE_ERROR_MESSAGES = Object.freeze({
  approval_busy: "已有一个本机操作正在等待确认",
  approval_denied: "本次本机操作未被允许",
  approval_expired: "一次性确认令牌已过期",
  approval_required: "必须先在本机确认框中允许这一次操作",
  invalid_action: "本机操作参数无效",
  invalid_token: "一次性确认令牌无效",
  permission_required: "需要先授予同频辅助功能和屏幕录制权限",
  sdk_api_mismatch: "Cua Driver 接口与当前安全适配层不匹配",
  sdk_unavailable: "Cua Driver 本机能力不可用",
  sdk_version_mismatch: "Cua Driver 本机版本不匹配",
  session_busy: "本机操作会话正在切换状态",
  session_consent_denied: "未允许开启本机操作会话",
  session_not_active: "尚未开始本机操作会话",
  session_start_failed: "本机操作会话启动失败",
  session_stop_failed: "本机操作会话已关闭，但原生运行时未能完整退出",
  target_changed: "目标窗口已变化，需要重新确认",
  target_not_found: "未找到需要操作的精确窗口",
  snapshot_expired: "窗口快照已过期，请重新读取后再确认",
  background_unavailable: "此窗口不支持安全的后台操作；未改用前台或全局输入",
  action_failed: "本次本机操作失败，不会自动重试",
  action_outcome_unknown: "本次操作结果无法确认，不会自动重试",
  window_list_failed: "无法获取当前可操作窗口",
  window_state_failed: "无法读取目标窗口的当前状态",
});

function failure(code, message = SAFE_ERROR_MESSAGES[code] ?? "本机操作不可用") {
  return { ok: false, error: { code, message } };
}

function success(value) {
  return { ok: true, value };
}

function timeoutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function withTimeout(run, timeoutMs = NATIVE_CALL_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError("native_timeout"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function baseCapabilities(enabled) {
  return {
    listWindows: enabled,
    getWindowState: enabled,
    sessions: enabled,
    click: enabled,
    typeText: enabled,
    scroll: enabled,
    safeKeys: enabled,
    perActionNativeConfirmation: true,
    shell: false,
    arbitraryTools: false,
    clipboard: false,
    fileAccess: false,
    sendDeleteOrPaymentWithoutConfirmation: false,
  };
}

function unsupportedProbe({ platform, arch, osVersion, status, message }) {
  return {
    sdkVersion: CUA_DRIVER_VERSION,
    platform,
    arch,
    osVersion,
    supported: false,
    available: false,
    status,
    message,
    permissions: {
      accessibility: "unknown",
      screenRecording: "unknown",
    },
    capabilities: baseCapabilities(false),
  };
}

function probePlatform(platform, arch, osVersion) {
  if (platform === "darwin") {
    const major = Number.parseInt(String(osVersion).split(".")[0] ?? "", 10);
    if (!Number.isInteger(major) || major < 13) {
      return unsupportedProbe({
        platform,
        arch,
        osVersion,
        status: "unsupported_os",
        message: "本机操作需要 macOS 13 或更高版本；macOS 12 明确不支持。",
      });
    }
    if (arch !== "arm64" && arch !== "x64") {
      return unsupportedProbe({
        platform,
        arch,
        osVersion,
        status: "unsupported_arch",
        message: "当前 Mac 处理器架构不在已锁定的支持范围内。",
      });
    }
    return null;
  }

  if (platform === "win32") {
    if (arch !== "x64") {
      return unsupportedProbe({
        platform,
        arch,
        osVersion,
        status: "unsupported_arch",
        message: "当前同频安装包只对 Windows x64 开放本机能力探测。",
      });
    }
    return null;
  }

  return unsupportedProbe({
    platform,
    arch,
    osVersion,
    status: "unsupported_os",
    message: "当前平台未纳入同频本机操作的支持范围。",
  });
}

function hasFactory(value) {
  return Boolean(value && typeof value.new === "function");
}

function validateSdk(sdk) {
  return Boolean(
    sdk &&
      typeof sdk.CuaDriver?.create === "function" &&
      hasFactory(sdk.StartSessionInput) &&
      hasFactory(sdk.EndSessionInput) &&
      hasFactory(sdk.ListWindowsInput) &&
      hasFactory(sdk.GetWindowStateInput) &&
      hasFactory(sdk.ClickInput) &&
      typeof sdk.ActionTarget?.Window?.new === "function" &&
      typeof sdk.ClickPosition?.Element?.new === "function" &&
      sdk.InputDeliveryMode &&
      sdk.ClickButton &&
      sdk.ActionEffect,
  );
}

function supportsElementTargetedTypeTool(rawTools) {
  try {
    const parsed = typeof rawTools === "string" ? JSON.parse(rawTools) : rawTools;
    const tools = Array.isArray(parsed) ? parsed : parsed?.tools;
    const tool = Array.isArray(tools)
      ? tools.find((candidate) => candidate?.name === "type_text")
      : null;
    const schema = tool?.inputSchema;
    const properties = schema?.properties;
    return Boolean(
      schema &&
      schema.type === "object" &&
      schema.additionalProperties === false &&
      Array.isArray(schema.required) &&
      schema.required.includes("text") &&
      properties?.text?.type === "string" &&
      properties?.element_token?.type === "string" &&
      properties?.target &&
      Array.isArray(properties?.delivery_mode?.enum) &&
      properties.delivery_mode.enum.includes("background"),
    );
  } catch {
    return false;
  }
}

function supportsElementTargetedInputTool(rawTools, name, requiredField) {
  try {
    const parsed = typeof rawTools === "string" ? JSON.parse(rawTools) : rawTools;
    const tools = Array.isArray(parsed) ? parsed : parsed?.tools;
    const schema = tools?.find((candidate) => candidate?.name === name)?.inputSchema;
    return Boolean(schema?.type === "object" && schema.additionalProperties === false &&
      schema.required?.includes(requiredField) &&
      schema.properties?.[requiredField]?.type === "string" &&
      schema.properties?.element_token?.type === "string" &&
      schema.properties?.target &&
      schema.properties?.delivery_mode?.enum?.includes("background"));
  } catch { return false; }
}

function safeLabel(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WINDOW_LABEL_LENGTH);
}

function safeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWindow(raw, hostPid) {
  if (!raw || typeof raw !== "object") return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0 || raw.pid > 2_147_483_647) {
    return null;
  }
  if (raw.pid === hostPid || raw.isOnScreen !== true || raw.minimized === true) {
    return null;
  }

  let windowId;
  try {
    windowId = BigInt(raw.windowId);
  } catch {
    return null;
  }
  if (windowId <= 0n || windowId > MAX_WINDOW_ID) return null;

  const appName = safeLabel(raw.appName);
  const title = safeLabel(raw.title);
  const x = safeFiniteNumber(raw.bounds?.x);
  const y = safeFiniteNumber(raw.bounds?.y);
  const width = safeFiniteNumber(raw.bounds?.width);
  const height = safeFiniteNumber(raw.bounds?.height);
  if (!appName || !title || x === null || y === null || width === null || height === null) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;

  return {
    pid: raw.pid,
    windowId: windowId.toString(),
    appName,
    title,
    bounds: { x, y, width, height },
  };
}

function safeObservationText(value, maxLength = MAX_ELEMENT_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\p{Cf}\p{Cs}]/gu, " ")
    .slice(0, maxLength);
}

function safeOpaqueToken(value, maxLength = 1_024) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\p{Cc}\p{Cf}\p{Cs}\s]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function safeOptionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeOptionalBigIntString(value) {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

function normalizeElement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const elementIndex = safeOptionalBigIntString(raw.elementIndex);
  if (elementIndex === undefined) return null;
  const role = safeLabel(raw.role);
  if (!role || !Number.isInteger(raw.depth) || raw.depth < 0 || raw.depth > 100) {
    return null;
  }
  const elementToken = raw.elementToken === undefined
    ? undefined
    : safeOpaqueToken(raw.elementToken);
  const frame = raw.frame && typeof raw.frame === "object"
    ? {
        x: safeOptionalNumber(raw.frame.x),
        y: safeOptionalNumber(raw.frame.y),
        width: safeOptionalNumber(raw.frame.width),
        height: safeOptionalNumber(raw.frame.height),
      }
    : undefined;
  const safeFrame = frame && Object.values(frame).every((value) => value !== undefined)
    ? frame
    : undefined;
  return {
    elementIndex,
    role,
    depth: raw.depth,
    ...(elementToken ? { elementToken } : {}),
    ...(typeof raw.label === "string"
      ? { label: safeObservationText(raw.label) ?? "" }
      : {}),
    ...(typeof raw.value === "string"
      ? { value: safeObservationText(raw.value) ?? "" }
      : {}),
    ...(typeof raw.valueDescription === "string"
      ? { valueDescription: safeObservationText(raw.valueDescription) ?? "" }
      : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.selected === "boolean" ? { selected: raw.selected } : {}),
    ...(typeof raw.inWebContent === "boolean"
      ? { inWebContent: raw.inWebContent }
      : {}),
    ...(Array.isArray(raw.actions)
      ? {
          actions: raw.actions
            .map((action) => safeLabel(action))
            .filter(Boolean)
            .slice(0, 20),
        }
      : {}),
    ...(safeOptionalBigIntString(raw.parentIndex) !== undefined
      ? { parentIndex: safeOptionalBigIntString(raw.parentIndex) }
      : {}),
    ...(safeFrame ? { frame: safeFrame } : {}),
    ...(safeOptionalNumber(raw.min) !== undefined ? { min: raw.min } : {}),
    ...(safeOptionalNumber(raw.max) !== undefined ? { max: raw.max } : {}),
  };
}

function isEditableElement(element) {
  const role = safeLabel(element?.role)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
  return Boolean(
    element?.elementToken &&
    element.enabled !== false &&
    safeLabel(element.label) &&
    !/(?:password|passcode|secret|api[\s_-]*key|verification[\s_-]*code|one[\s_-]*time|密码|口令|验证码|密钥)/i.test(element.label) &&
    EDITABLE_ELEMENT_ROLES.has(role),
  );
}

function normalizeSnapshotImage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mimeType = typeof raw.mimeType === "string"
    ? raw.mimeType.toLowerCase()
    : "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return null;
  if (
    typeof raw.dataBase64 !== "string" ||
    raw.dataBase64.length === 0 ||
    raw.dataBase64.length > MAX_SCREENSHOT_BASE64_LENGTH ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.dataBase64)
  ) {
    return null;
  }
  return { mimeType, dataBase64: raw.dataBase64 };
}

function normalizeWindowState(raw, target, window) {
  if (!raw || typeof raw !== "object" || raw.pid !== target.pid) return null;
  let returnedWindowId;
  try {
    returnedWindowId = BigInt(raw.windowId).toString();
  } catch {
    return null;
  }
  if (returnedWindowId !== target.windowId || !Array.isArray(raw.images)) return null;

  const snapshotId = raw.snapshotId === undefined
    ? null
    : safeOpaqueToken(raw.snapshotId, 256);
  const rawTree = typeof raw.treeMarkdown === "string" ? raw.treeMarkdown : null;
  const treeMarkdown = rawTree === null
    ? null
    : safeObservationText(rawTree, MAX_TREE_MARKDOWN_LENGTH);
  const elements = Array.isArray(raw.elements)
    ? raw.elements
        .slice(0, SNAPSHOT_MAX_ELEMENTS)
        .map(normalizeElement)
        .filter(Boolean)
    : [];
  const firstRawImage = raw.images[0];
  const screenshot = normalizeSnapshotImage(firstRawImage);
  const screenshotOmitted = Boolean(firstRawImage && !screenshot);
  const windowBounds = raw.windowBounds && typeof raw.windowBounds === "object"
    ? {
        x: safeOptionalNumber(raw.windowBounds.x),
        y: safeOptionalNumber(raw.windowBounds.y),
        width: safeOptionalNumber(raw.windowBounds.width),
        height: safeOptionalNumber(raw.windowBounds.height),
      }
    : undefined;
  const safeWindowBounds = windowBounds &&
    Object.values(windowBounds).every((value) => value !== undefined) &&
    windowBounds.width > 0 &&
    windowBounds.height > 0
    ? windowBounds
    : undefined;

  return {
    contentTrust: "untrusted-observation",
    target: { pid: target.pid, windowId: target.windowId },
    snapshotId,
    appName: safeLabel(raw.appName) || window.appName,
    windowTitle: safeLabel(raw.windowTitle) || window.title,
    treeMarkdown,
    elements,
    counts: {
      elementCount: safeOptionalBigIntString(raw.elementCount),
      totalElementCount: safeOptionalBigIntString(raw.totalElementCount),
      returnedElementCount: safeOptionalBigIntString(raw.returnedElementCount),
      filteredElementCount: safeOptionalBigIntString(raw.filteredElementCount),
    },
    elementsComplete: raw.elementsComplete === true,
    degraded: raw.degraded === true || screenshotOmitted,
    degradedReason: screenshotOmitted
      ? "screenshot_omitted_by_local_size_or_type_limit"
      : safeObservationText(raw.degradedReason, 300),
    truncated:
      raw.truncated === true ||
      elements.length < (Array.isArray(raw.elements) ? raw.elements.length : 0) ||
      (rawTree !== null && rawTree.length > MAX_TREE_MARKDOWN_LENGTH),
    truncationReason: safeObservationText(raw.truncationReason, 300),
    screenshot: screenshot
      ? {
          ...screenshot,
          width: safeOptionalNumber(raw.screenshotWidth),
          height: safeOptionalNumber(raw.screenshotHeight),
          scale: safeOptionalNumber(raw.screenshotScale),
          frameValid: raw.screenshotFrameValid === true,
        }
      : null,
    windowBounds: safeWindowBounds ?? window.bounds,
  };
}

function windowKey(target) {
  return `${target.pid}:${target.windowId}`;
}

function windowFingerprint(window) {
  return [
    window.pid,
    window.windowId,
    window.appName,
    window.title,
    window.bounds.x,
    window.bounds.y,
    window.bounds.width,
    window.bounds.height,
  ].join("|");
}

function elementIdentity(element) {
  const { elementToken: _ephemeralToken, ...stableElement } = element;
  return JSON.stringify(stableElement);
}

function windowStateVersion(state) {
  const semanticState = {
    target: state.target,
    appName: state.appName,
    windowTitle: state.windowTitle,
    treeMarkdown: state.treeMarkdown,
    elements: state.elements.map((element) => {
      const { elementToken: _ephemeralToken, ...stableElement } = element;
      return stableElement;
    }),
    counts: state.counts,
    elementsComplete: state.elementsComplete,
    degraded: state.degraded,
    degradedReason: state.degradedReason,
    truncated: state.truncated,
    truncationReason: state.truncationReason,
    windowBounds: state.windowBounds,
  };
  return createHash("sha256").update(JSON.stringify(semanticState)).digest("hex");
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function normalizeTarget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!hasOnlyKeys(raw, ["pid", "windowId"])) return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0 || raw.pid > 2_147_483_647) {
    return null;
  }
  if (typeof raw.windowId !== "string" || !/^[1-9]\d{0,19}$/.test(raw.windowId)) {
    return null;
  }
  try {
    const id = BigInt(raw.windowId);
    if (id <= 0n || id > MAX_WINDOW_ID) return null;
  } catch {
    return null;
  }
  return { pid: raw.pid, windowId: raw.windowId };
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const target = normalizeTarget(raw.target);
  if (!target) return null;

  if (raw.kind === "click") {
    if (hasOnlyKeys(raw, ["kind", "target", "snapshotId", "elementToken"])) {
      const snapshotId = safeOpaqueToken(raw.snapshotId, 256);
      const elementToken = safeOpaqueToken(raw.elementToken);
      if (!snapshotId || !elementToken) return null;
      return { kind: "click", target, snapshotId, elementToken };
    }
    return null;
  }

  if (raw.kind === "type") {
    if (!hasOnlyKeys(raw, ["kind", "target", "snapshotId", "elementToken", "text"])) return null;
    const snapshotId = safeOpaqueToken(raw.snapshotId, 256);
    const elementToken = safeOpaqueToken(raw.elementToken);
    if (
      !snapshotId ||
      !elementToken ||
      typeof raw.text !== "string" ||
      raw.text.trim().length === 0 ||
      [...raw.text].length > MAX_TEXT_LENGTH ||
      /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(raw.text)
    ) {
      return null;
    }
    return { kind: "type", target, snapshotId, elementToken, text: raw.text };
  }

  if (raw.kind === "scroll") {
    if (!hasOnlyKeys(raw, ["kind", "target", "snapshotId", "elementToken", "direction", "amount"])) return null;
    const snapshotId = safeOpaqueToken(raw.snapshotId, 256);
    const elementToken = safeOpaqueToken(raw.elementToken);
    if (!snapshotId || !elementToken || !SCROLL_DIRECTIONS.has(raw.direction) || !Number.isInteger(raw.amount) || raw.amount < 1 || raw.amount > 3) return null;
    return { kind: "scroll", target, snapshotId, elementToken, direction: raw.direction, amount: raw.amount };
  }

  if (raw.kind === "key") {
    if (!hasOnlyKeys(raw, ["kind", "target", "snapshotId", "elementToken", "key"])) return null;
    const snapshotId = safeOpaqueToken(raw.snapshotId, 256);
    const elementToken = safeOpaqueToken(raw.elementToken);
    if (!snapshotId || !elementToken || !SAFE_KEYS.has(raw.key)) return null;
    return { kind: "key", target, snapshotId, elementToken, key: raw.key };
  }

  return null;
}

function loadPackagedOrInstalledSdk() {
  const packagedRoot = typeof process.resourcesPath === "string"
    ? path.join(process.resourcesPath, "app.asar.unpacked")
    : "";
  if (process.versions.electron && __dirname.includes("app.asar") && packagedRoot) {
    const entrypoint = path.join(
      packagedRoot,
      "node_modules",
      "@trycua",
      "cua-driver",
      "dist",
      "index.js",
    );
    return import(pathToFileURL(entrypoint).href);
  }
  return import("@trycua/cua-driver");
}

function actionSummary(action, window, snapshot) {
  const windowName = `${window.appName} — ${window.title}`;
  if (action.kind === "click") {
    const element = snapshot?.elementsByToken?.get(action.elementToken);
    const label = safeLabel(element?.label) || "无标签控件";
    const role = safeLabel(element?.role) || "未知角色";
    const clickTarget = `精确控件“${label}”（${role}）`;
    return {
      title: "确认一次本机单击",
      message: `在「${windowName}」内单击${clickTarget}？`,
      detail:
        "窗口标题和控件标签来自不可信的窗口内容，仅用于帮你核对目标。只会允许这一次左键单击；它可能触发发送、删除或付款，请先确认无风险。同频不会自动重试。",
      summary: `单击 ${windowName} 的${clickTarget}`,
    };
  }
  if (action.kind === "scroll" || action.kind === "key") {
    const element = snapshot?.elementsByToken?.get(action.elementToken);
    const label = safeLabel(element?.label) || "无标签控件";
    const verb = action.kind === "scroll"
      ? `向${{ up: "上", down: "下", left: "左", right: "右" }[action.direction]}滚动 ${action.amount} 格`
      : `按一次${{ escape: "Esc", up: "上方向键", down: "下方向键", left: "左方向键", right: "右方向键" }[action.key]}`;
    return {
      title: action.kind === "scroll" ? "确认一次本机滚动" : "确认一次安全按键",
      message: `在「${windowName}」的精确控件“${label}”上${verb}？`,
      detail: "只对这一次、这个窗口和快照控件生效；不使用全局焦点、组合热键、回车或删除。窗口标签来自不可信内容，请核对后再确认。同频不会自动重试。",
      summary: `在 ${windowName} 的“${label}”上${verb}`,
    };
  }
  const element = snapshot?.elementsByToken?.get(action.elementToken);
  const label = safeLabel(element?.label) || "无标签输入框";
  const role = safeLabel(element?.role) || "未知角色";
  const characterCount = [...action.text].length;
  return {
    title: "确认一次本机输入",
    message: `在「${windowName}」的精确控件“${label}”（${role}）中输入下列完整文字？`,
    detail: `「${action.text}」\n\n只会定向这个快照控件允许这一次输入；不使用未知当前焦点，不包含回车或发送，同频不会自动重试。`,
    summary: `在 ${windowName} 的“${label}”中输入 ${characterCount} 个字符`,
  };
}

function elementTargetedTypeArgumentsJson(action, freshElementToken, session) {
  // windowId is already a validated unsigned decimal string. Writing it as a
  // JSON integer here preserves the full uint64 for the Rust parser instead of
  // rounding it through a JavaScript Number.
  return `{"text":${JSON.stringify(action.text)},"target":{"kind":"window","pid":${action.target.pid},"window_id":${action.target.windowId}},"element_token":${JSON.stringify(freshElementToken)},"session":${JSON.stringify(session)},"delivery_mode":"background"}`;
}

function elementTargetedNavigationArgumentsJson(action, freshElementToken, session) {
  const verb = action.kind === "scroll"
    ? `"direction":${JSON.stringify(action.direction)},"by":"line","amount":${action.amount},`
    : `"key":${JSON.stringify(action.key)},`;
  // Fixed keys and arguments only. The validated decimal uint64 must not be
  // rounded through Number; there is no desktop scope or foreground fallback.
  return `{${verb}"target":{"kind":"window","pid":${action.target.pid},"window_id":${action.target.windowId}},"element_token":${JSON.stringify(freshElementToken)},"session":${JSON.stringify(session)},"delivery_mode":"background"}`;
}

function createComputerUseController({
  platform = process.platform,
  arch = process.arch,
  osVersion = "",
  hostPid = process.pid,
  loadSdk = loadPackagedOrInstalledSdk,
  confirmSession = async () => false,
  confirmAction = async () => false,
  now = () => Date.now(),
  createToken = () => randomBytes(32).toString("base64url"),
  createSessionId = () => `tongpin-${randomUUID()}`,
} = {}) {
  let sdkPromise = null;
  let driver = null;
  let sessionId = null;
  let lifecycleState = "stopped";
  let startPromise = null;
  let stopPromise = null;
  let approvalPending = false;
  let sessionDeadlineMs = 0;
  let executionAttempts = 0;
  let approvedWindowKey = null;
  const approvals = new Map();
  const knownWindows = new Map();
  const latestSnapshots = new Map();

  async function getSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.resolve().then(loadSdk);
    }
    const sdk = await sdkPromise;
    if (!validateSdk(sdk)) throw timeoutError("sdk_api_mismatch");
    return sdk;
  }

  async function probe() {
    const unsupported = probePlatform(platform, arch, osVersion);
    if (unsupported) return unsupported;

    let sdk;
    try {
      sdk = await withTimeout(() => getSdk(), 5_000);
    } catch (error) {
      const code = error?.code === "sdk_api_mismatch" ? "sdk_api_mismatch" : "sdk_unavailable";
      return {
        ...unsupportedProbe({
          platform,
          arch,
          osVersion,
          status: code,
          message: SAFE_ERROR_MESSAGES[code],
        }),
        supported: true,
      };
    }

    if (platform === "darwin") {
      if (typeof sdk.currentMacOsPermissionStatus !== "function") {
        return {
          ...unsupportedProbe({
            platform,
            arch,
            osVersion,
            status: "sdk_api_mismatch",
            message: SAFE_ERROR_MESSAGES.sdk_api_mismatch,
          }),
          supported: true,
        };
      }
      let permissionStatus;
      try {
        permissionStatus = sdk.currentMacOsPermissionStatus();
      } catch {
        return {
          ...unsupportedProbe({
            platform,
            arch,
            osVersion,
            status: "permission_probe_failed",
            message: "无法确认同频当前的 macOS 系统权限。",
          }),
          supported: true,
        };
      }
      const accessibility = permissionStatus?.accessibility === true;
      const screenRecording = permissionStatus?.screenRecording === true;
      const available = accessibility && screenRecording;
      return {
        sdkVersion: CUA_DRIVER_VERSION,
        platform,
        arch,
        osVersion,
        supported: true,
        available,
        status: available ? "ready" : "permission_required",
        message: available ? "本机操作能力已就绪" : SAFE_ERROR_MESSAGES.permission_required,
        permissions: {
          accessibility: accessibility ? "granted" : "denied",
          screenRecording: screenRecording ? "granted" : "denied",
        },
        capabilities: baseCapabilities(available),
      };
    }

    return {
      sdkVersion: CUA_DRIVER_VERSION,
      platform,
      arch,
      osVersion,
      supported: true,
      available: true,
      status: "ready",
      message: "Windows x64 本机能力已通过 SDK 探测",
      permissions: {
        accessibility: "not-required",
        screenRecording: "not-required",
      },
      capabilities: baseCapabilities(true),
    };
  }

  async function disposeDriver(targetDriver, targetSessionId) {
    const failures = [];
    if (targetSessionId && typeof targetDriver?.endSession === "function") {
      try {
        const sdk = await getSdk();
        await withTimeout((signal) =>
          targetDriver.endSession(
            sdk.EndSessionInput.new({ session: targetSessionId }),
            { signal },
          ),
        );
      } catch {
        failures.push("end_session");
      }
    }
    if (typeof targetDriver?.shutdown === "function") {
      try {
        await withTimeout((signal) => targetDriver.shutdown({ signal }));
      } catch {
        failures.push("shutdown");
      }
    }
    try {
      targetDriver?.uniffiDestroy?.();
    } catch {
      failures.push("destroy");
    }
    return failures;
  }

  async function startSessionInternal() {
    const capability = await probe();
    if (!capability.available) {
      return failure(
        capability.status === "permission_required" ? "permission_required" : "sdk_unavailable",
        capability.message,
      );
    }

    let consented = false;
    try {
      consented = (await confirmSession()) === true;
    } catch {
      consented = false;
    }
    if (!consented) {
      lifecycleState = "stopped";
      return failure("session_consent_denied");
    }

    let nextDriver = null;
    let nextSessionId = null;
    try {
      const sdk = await getSdk();
      nextDriver = sdk.CuaDriver.create(undefined);
      if (
        !nextDriver ||
        typeof nextDriver.metadata !== "function" ||
        typeof nextDriver.startSession !== "function" ||
        typeof nextDriver.endSession !== "function" ||
        typeof nextDriver.listWindows !== "function" ||
        typeof nextDriver.getWindowState !== "function" ||
        typeof nextDriver.click !== "function" ||
        typeof nextDriver.listToolsJson !== "function" ||
        typeof nextDriver.callTool !== "function" ||
        typeof nextDriver.shutdown !== "function"
      ) {
        throw timeoutError("sdk_api_mismatch");
      }
      const metadata = await withTimeout((signal) => nextDriver.metadata({ signal }), 5_000);
      if (metadata?.driverVersion !== CUA_DRIVER_VERSION || metadata?.embedded !== true) {
        throw timeoutError("sdk_version_mismatch");
      }
      const toolsJson = await withTimeout(
        (signal) => nextDriver.listToolsJson({ signal }),
        5_000,
      );
      if (!supportsElementTargetedTypeTool(toolsJson) ||
        !supportsElementTargetedInputTool(toolsJson, "scroll", "direction") ||
        !supportsElementTargetedInputTool(toolsJson, "press_key", "key")) {
        throw timeoutError("sdk_api_mismatch");
      }
      nextSessionId = createSessionId();
      const started = await withTimeout((signal) =>
        nextDriver.startSession(
          sdk.StartSessionInput.new({ session: nextSessionId }),
          { signal },
        ),
      );
      if (started?.active !== true) throw timeoutError("session_start_failed");

      driver = nextDriver;
      sessionId = nextSessionId;
      lifecycleState = "running";
      sessionDeadlineMs = now() + SESSION_MAX_DURATION_MS;
      executionAttempts = 0;
      approvedWindowKey = null;
      approvals.clear();
      knownWindows.clear();
      latestSnapshots.clear();
      return success({ sessionId, state: "running", revived: started.revived === true });
    } catch (error) {
      if (nextDriver) await disposeDriver(nextDriver, nextSessionId);
      lifecycleState = "stopped";
      driver = null;
      sessionId = null;
      const code = ["sdk_api_mismatch", "sdk_version_mismatch"].includes(error?.code)
        ? error.code
        : "session_start_failed";
      return failure(code);
    }
  }

  async function startSession() {
    if (lifecycleState === "running" && sessionId) {
      return failure("session_busy", "已有一个本机操作会话在运行，请先关闭再重新开启");
    }
    if (lifecycleState === "starting" && startPromise) return startPromise;
    if (lifecycleState === "stopping") return failure("session_busy");
    lifecycleState = "starting";
    startPromise = startSessionInternal().finally(() => {
      startPromise = null;
      if (lifecycleState === "starting") lifecycleState = "stopped";
    });
    return startPromise;
  }

  async function stopSessionInternal() {
    const previousDriver = driver;
    const previousSessionId = sessionId;
    driver = null;
    sessionId = null;
    approvals.clear();
    knownWindows.clear();
    latestSnapshots.clear();
    const failures = await disposeDriver(previousDriver, previousSessionId);
    lifecycleState = "stopped";
    if (failures.length > 0) return failure("session_stop_failed");
    return success({ sessionId: null, state: "stopped" });
  }

  async function stopSession() {
    if (lifecycleState === "starting" && startPromise) await startPromise;
    if (lifecycleState === "stopping" && stopPromise) return stopPromise;
    if (lifecycleState === "stopped" && !driver) {
      approvals.clear();
      knownWindows.clear();
      latestSnapshots.clear();
      return success({ sessionId: null, state: "stopped" });
    }
    lifecycleState = "stopping";
    stopPromise = stopSessionInternal().finally(() => {
      stopPromise = null;
      lifecycleState = "stopped";
    });
    return stopPromise;
  }

  async function refreshWindows() {
    if (lifecycleState !== "running" || !driver || !sessionId) {
      return failure("session_not_active");
    }
    try {
      const sdk = await getSdk();
      const output = await withTimeout((signal) =>
        driver.listWindows(sdk.ListWindowsInput.new({ onScreenOnly: true }), { signal }),
      );
      if (!output || !Array.isArray(output.windows)) return failure("window_list_failed");
      const windows = output.windows
        .map((window) => normalizeWindow(window, hostPid))
        .filter(Boolean)
        .slice(0, MAX_WINDOWS);
      knownWindows.clear();
      for (const window of windows) knownWindows.set(windowKey(window), window);
      return success({ windows });
    } catch {
      return failure("window_list_failed");
    }
  }

  async function listWindows() {
    return refreshWindows();
  }

  async function getWindowState(rawTarget) {
    const target = normalizeTarget(rawTarget);
    if (!target) return failure("target_not_found");
    const windowsResult = await refreshWindows();
    if (!windowsResult.ok) return windowsResult;
    const window = knownWindows.get(windowKey(target));
    if (!window) return failure("target_not_found");

    try {
      const state = await captureWindowState(target, window);
      if (!state) return failure("window_state_failed");
      const elementsByToken = new Map(
        state.elements.flatMap((element) => element.elementToken
          ? [[element.elementToken, {
              identity: elementIdentity(element),
              label: element.label,
              role: element.role,
              editable: isEditableElement(element),
            }]]
          : []),
      );
      latestSnapshots.set(windowKey(target), {
        snapshotId: state.snapshotId,
        elementsByToken,
        stateVersion: windowStateVersion(state),
        targetFingerprint: windowFingerprint(window),
        capturedAtMs: now(),
      });
      return success(state);
    } catch {
      return failure("window_state_failed");
    }
  }

  async function captureWindowState(target, window) {
    const sdk = await getSdk();
    const output = await withTimeout((signal) =>
      driver.getWindowState(
        sdk.GetWindowStateInput.new({
          pid: target.pid,
          windowId: BigInt(target.windowId),
          session: sessionId,
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxElements: SNAPSHOT_MAX_ELEMENTS,
          maxDepth: SNAPSHOT_MAX_DEPTH,
          maxDimension: SNAPSHOT_MAX_DIMENSION,
        }),
        { signal },
      ),
    );
    return normalizeWindowState(output, target, window);
  }

  function actionFitsSnapshot(action, window) {
    const snapshot = latestSnapshots.get(windowKey(action.target));
    if (!snapshot || snapshot.snapshotId !== action.snapshotId) return "missing";
    if (now() - snapshot.capturedAtMs > SNAPSHOT_TTL_MS) return "expired";
    if (snapshot.targetFingerprint !== windowFingerprint(window)) return "changed";
    if (!snapshot.elementsByToken.has(action.elementToken)) {
      return "changed";
    }
    if (action.kind === "type" && !snapshot.elementsByToken.get(action.elementToken)?.editable) {
      return "invalid";
    }
    return "fresh";
  }

  async function requestActionApproval(rawAction) {
    const action = normalizeAction(rawAction);
    if (!action) return failure("invalid_action");
    if (lifecycleState !== "running" || !driver || !sessionId) {
      return failure("session_not_active");
    }
    if (approvalPending) return failure("approval_busy");
    if (now() >= sessionDeadlineMs || executionAttempts >= SESSION_MAX_ACTIONS) {
      approvals.clear();
      return failure("session_not_active", "本次电脑任务已达到步骤或时长上限，请停止后重新开启会话");
    }
    if (approvedWindowKey && approvedWindowKey !== windowKey(action.target)) return failure("target_changed");

    const windowsResult = await refreshWindows();
    if (!windowsResult.ok) return windowsResult;
    const window = knownWindows.get(windowKey(action.target));
    if (!window) return failure("target_not_found");
    const snapshotFit = actionFitsSnapshot(action, window);
    if (snapshotFit === "expired") return failure("snapshot_expired");
    if (snapshotFit === "invalid") return failure("invalid_action");
    if (snapshotFit !== "fresh") return failure("target_changed");

    const expectedSessionId = sessionId;
    const snapshot = latestSnapshots.get(windowKey(action.target));
    const prompt = actionSummary(action, window, snapshot);
    approvalPending = true;
    let approved = false;
    try {
      approved = (await confirmAction({ ...prompt, action, window })) === true;
    } catch {
      approved = false;
    } finally {
      approvalPending = false;
    }
    if (!approved) return failure("approval_denied");
    if (lifecycleState !== "running" || sessionId !== expectedSessionId) {
      return failure("session_not_active");
    }
    if (now() >= sessionDeadlineMs || executionAttempts >= SESSION_MAX_ACTIONS) return failure("session_not_active");
    approvedWindowKey = windowKey(action.target);

    approvals.clear();
    const token = createToken();
    const expiresAtMs = now() + APPROVAL_TTL_MS;
    approvals.set(token, {
      action,
      expiresAtMs,
      sessionId: expectedSessionId,
      targetFingerprint: windowFingerprint(window),
      stateVersion: snapshot.stateVersion,
      elementIdentity: snapshot.elementsByToken.get(action.elementToken)?.identity,
    });
    return success({
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      summary: prompt.summary,
    });
  }

  function actionEffectName(sdk, value) {
    const entries = Object.entries(sdk.ActionEffect ?? {});
    return entries.find(([, enumValue]) => enumValue === value)?.[0] ?? "Unknown";
  }

  function actionOutcome(sdk, kind, effect) {
    if (effect === sdk.ActionEffect.Refused) return failure("action_failed");
    if (
      effect === undefined ||
      effect === sdk.ActionEffect.SuspectedNoop ||
      actionEffectName(sdk, effect) === "Unknown"
    ) {
      return failure("action_outcome_unknown");
    }
    const effectName = actionEffectName(sdk, effect);
    return success({
      kind,
      state: effectName === "Confirmed" ? "delivered" : "delivered_unverified",
      effect: effectName,
    });
  }

  async function executeApprovedAction(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 200) {
      return failure("invalid_token");
    }
    const approval = approvals.get(rawToken);
    approvals.delete(rawToken);
    if (!approval) return failure("approval_required");
    if (now() >= sessionDeadlineMs || executionAttempts >= SESSION_MAX_ACTIONS) {
      approvals.clear();
      return failure("session_not_active", "本次电脑任务已达到步骤或时长上限，未执行后续动作");
    }
    if (now() > approval.expiresAtMs) return failure("approval_expired");
    if (
      lifecycleState !== "running" ||
      !driver ||
      !sessionId ||
      sessionId !== approval.sessionId
    ) {
      return failure("session_not_active");
    }

    const windowsResult = await refreshWindows();
    if (!windowsResult.ok) return windowsResult;
    const window = knownWindows.get(windowKey(approval.action.target));
    if (!window || windowFingerprint(window) !== approval.targetFingerprint) {
      return failure("target_changed");
    }
    const snapshotFit = actionFitsSnapshot(approval.action, window);
    if (snapshotFit === "expired") return failure("snapshot_expired");
    if (snapshotFit !== "fresh") return failure("target_changed");

    // A native confirmation can stay open while the target UI changes. Capture
    // the same bounded window again after approval and reject any semantic
    // change before invoking input. Snapshot element tokens are intentionally
    // ephemeral, so an unchanged element is rebound to its fresh token.
    let freshState;
    try {
      freshState = await captureWindowState(approval.action.target, window);
    } catch {
      return failure("window_state_failed");
    }
    if (
      !freshState?.snapshotId ||
      windowStateVersion(freshState) !== approval.stateVersion
    ) {
      return failure("target_changed");
    }
    if (now() > approval.expiresAtMs) return failure("approval_expired");
    if (now() >= sessionDeadlineMs || executionAttempts >= SESSION_MAX_ACTIONS) return failure("session_not_active");
    if (
      lifecycleState !== "running" ||
      !driver ||
      !sessionId ||
      sessionId !== approval.sessionId
    ) {
      return failure("session_not_active");
    }

    const matchingElements = freshState.elements.filter((element) =>
      Boolean(
        element.elementToken &&
        approval.elementIdentity &&
        elementIdentity(element) === approval.elementIdentity,
      ),
    );
    if (
      matchingElements.length !== 1 ||
      !matchingElements[0].elementToken ||
      (approval.action.kind === "type" && !isEditableElement(matchingElements[0]))
    ) {
      return failure("target_changed");
    }
    const executableAction = {
      ...approval.action,
      snapshotId: freshState.snapshotId,
      elementToken: matchingElements[0].elementToken,
    };

    // Each bounded observation authorizes at most one execution attempt.
    // The renderer must observe again before it can plan another action.
    latestSnapshots.delete(windowKey(approval.action.target));
    executionAttempts += 1;

    try {
      const sdk = await getSdk();
      const target = sdk.ActionTarget.Window.new({
        pid: approval.action.target.pid,
        windowId: BigInt(approval.action.target.windowId),
      });
      if (executableAction.kind === "click") {
        const position = sdk.ClickPosition.Element.new({
          elementToken: executableAction.elementToken,
        });
        const result = await withTimeout((signal) =>
          driver.click(
            sdk.ClickInput.new({
              target,
              position,
              // Semantic, exact-window delivery must not steal global focus.
              // Unsupported background routes fail closed; never retry in the
              // foreground and risk clicking another application.
              deliveryMode: sdk.InputDeliveryMode.Background,
              session: approval.sessionId,
              button: sdk.ClickButton.Left,
              count: 1,
            }),
            { signal },
          ),
        );
        if (!result) return failure("action_outcome_unknown");
        return actionOutcome(sdk, "click", result.effect);
      }

      if (executableAction.kind === "scroll" || executableAction.kind === "key") {
        const result = await withTimeout((signal) => driver.callTool(
          executableAction.kind === "scroll" ? "scroll" : "press_key",
          elementTargetedNavigationArgumentsJson(executableAction, executableAction.elementToken, approval.sessionId),
          { signal },
        ));
        if (result?.isError === true && result.errorCode === "background_unavailable") {
          return failure("background_unavailable");
        }
        if (!result || result.isError !== false || !result.action) return failure("action_failed");
        return actionOutcome(sdk, executableAction.kind, result.action.effect);
      }

      // The typed 0.28.1 TypeTextInput has no element field and therefore can
      // fall back to ambient focus. Its closed type_text contract does support
      // a fresh element_token. The tool name and every argument key are fixed
      // here; no generic tool surface crosses IPC.
      const result = await withTimeout((signal) =>
        driver.callTool(
          "type_text",
          elementTargetedTypeArgumentsJson(
            executableAction,
            executableAction.elementToken,
            approval.sessionId,
          ),
          { signal },
        ),
      );
      if (!result || result.isError !== false || !result.action) return failure("action_failed");
      return actionOutcome(sdk, "type", result.action?.effect);
    } catch (error) {
      return failure(error?.code === "native_timeout" ? "action_outcome_unknown" : "action_failed");
    }
  }

  return Object.freeze({
    probe,
    listWindows,
    getWindowState,
    startSession,
    stopSession,
    requestActionApproval,
    executeApprovedAction,
    shutdown: stopSession,
    needsShutdown: () => lifecycleState !== "stopped" || Boolean(driver),
  });
}

module.exports = {
  APPROVAL_TTL_MS,
  CUA_DRIVER_VERSION,
  SNAPSHOT_TTL_MS,
  computerUseSystemVersion,
  createComputerUseController,
  normalizeAction,
  probePlatform,
};
