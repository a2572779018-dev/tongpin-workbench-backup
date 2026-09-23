import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  APPROVAL_TTL_MS,
  CUA_DRIVER_VERSION,
  SNAPSHOT_TTL_MS,
  createComputerUseController,
  normalizeAction,
  probePlatform,
} = require("./computer-use.cjs");

function testWindow(overrides = {}) {
  return {
    windowId: 9_007_199_254_740_993n,
    pid: 42,
    appName: "Notes",
    title: "Draft",
    bounds: { x: 20, y: 30, width: 800, height: 600 },
    isOnScreen: true,
    minimized: false,
    ...overrides,
  };
}

function makeFakeSdk(options = {}) {
  const calls = {
    click: [],
    typeText: [],
    callTool: [],
    windowState: [],
  };
  const driver = {
    metadata: vi.fn(async () => ({
      driverVersion: options.driverVersion ?? CUA_DRIVER_VERSION,
      embedded: options.embedded ?? true,
    })),
    startSession: vi.fn(async (input) => typeof options.startSession === "function"
      ? options.startSession(input)
      : ({ active: true, revived: false })),
    endSession: vi.fn(async () => ({ ended: true })),
    listWindows: vi.fn(async () => ({
      windows: typeof options.windows === "function"
        ? options.windows()
        : (options.windows ?? [testWindow()]),
    })),
    getWindowState: vi.fn(async (input) => {
      calls.windowState.push(input);
      if (typeof options.windowState === "function") return options.windowState(input);
      return options.windowState ?? {
        pid: input.pid,
        windowId: input.windowId,
        snapshotId: "snapshot-1",
        appName: "Notes",
        windowTitle: "Draft",
        treeMarkdown: "- button: Save",
        elements: [
          {
            elementIndex: 1n,
            role: "button",
            depth: 1,
            elementToken: "element-token-1",
            label: "Save",
            enabled: true,
          },
        ],
        elementCount: 1n,
        elementsComplete: true,
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotScale: 1,
        screenshotMimeType: "image/png",
        screenshotFrameValid: true,
        images: [{ mimeType: "image/png", dataBase64: "aGVsbG8=" }],
      };
    }),
    click: vi.fn(async (input) => {
      calls.click.push(input);
      return options.clickResult ?? { effect: 0, route: 1 };
    }),
    typeText: vi.fn(async (input) => {
      calls.typeText.push(input);
      return options.typeResult ?? { isError: false, action: { effect: 0 } };
    }),
    listToolsJson: vi.fn(async () => JSON.stringify(options.tools ?? [{
      name: "type_text",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string" },
          element_token: { type: "string" },
          target: { type: ["object", "null"] },
          delivery_mode: { type: "string", enum: ["background", "foreground"] },
        },
      },
    }, ...["scroll", "press_key"].map(name => ({
      name,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [name === "scroll" ? "direction" : "key"],
        properties: {
          [name === "scroll" ? "direction" : "key"]: { type: "string" },
          element_token: { type: "string" },
          target: { type: ["object", "null"] },
          delivery_mode: { type: "string", enum: ["background", "foreground"] },
        },
      },
    }))])),
    callTool: vi.fn(async (name, argumentsJson) => {
      calls.callTool.push({ name, argumentsJson });
      return options.typeResult ?? { isError: false, action: { effect: 0 } };
    }),
    shutdown: vi.fn(async () => undefined),
    uniffiDestroy: vi.fn(),
  };
  const factory = (value) => value;
  const sdk = {
    CuaDriver: { create: vi.fn(() => driver) },
    StartSessionInput: { new: factory },
    EndSessionInput: { new: factory },
    ListWindowsInput: { new: factory },
    GetWindowStateInput: { new: factory },
    ClickInput: { new: factory },
    TypeTextInput: { new: factory },
    ActionTarget: {
      Window: { new: (inner) => ({ tag: "Window", inner }) },
    },
    ClickPosition: {
      Coordinates: { new: (inner) => ({ tag: "Coordinates", inner }) },
      Element: { new: (inner) => ({ tag: "Element", inner }) },
    },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
    ClickButton: { Left: 0, Right: 1, Middle: 2 },
    ActionEffect: {
      Confirmed: 0,
      Partial: 1,
      Unverifiable: 2,
      SuspectedNoop: 3,
      Refused: 4,
    },
    currentMacOsPermissionStatus: vi.fn(() =>
      options.permissions ?? { accessibility: true, screenRecording: true },
    ),
  };
  return { sdk, driver, calls };
}

function makeController(fake, overrides = {}) {
  return createComputerUseController({
    platform: "win32",
    arch: "x64",
    osVersion: "10.0.26100",
    hostPid: 7,
    loadSdk: async () => fake.sdk,
    createSessionId: () => "tongpin-test-session",
    createToken: () => "t".repeat(43),
    confirmSession: async () => true,
    ...overrides,
  });
}

describe("computer-use platform and capability gate", () => {
  it("rejects macOS 12 before loading the native SDK", async () => {
    const loadSdk = vi.fn();
    const controller = createComputerUseController({
      platform: "darwin",
      arch: "arm64",
      osVersion: "12.7.6",
      loadSdk,
    });

    const result = await controller.probe();

    expect(result).toMatchObject({
      supported: false,
      available: false,
      status: "unsupported_os",
    });
    expect(result.message).toContain("macOS 12");
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it("allows a read-only capability probe on Windows x64", async () => {
    const fake = makeFakeSdk();
    const result = await makeController(fake).probe();

    expect(result).toMatchObject({
      supported: true,
      available: true,
      status: "ready",
      platform: "win32",
      arch: "x64",
      sdkVersion: "0.28.1",
    });
    expect(result.capabilities).toMatchObject({
      listWindows: true,
      click: true,
      typeText: true,
      scroll: true,
      safeKeys: true,
      shell: false,
      arbitraryTools: false,
      clipboard: false,
      sendDeleteOrPaymentWithoutConfirmation: false,
    });
    expect(fake.sdk.CuaDriver.create).not.toHaveBeenCalled();
  });

  it("reports missing macOS permission without prompting or starting", async () => {
    const fake = makeFakeSdk({
      permissions: { accessibility: true, screenRecording: false },
    });
    const controller = makeController(fake, {
      platform: "darwin",
      arch: "arm64",
      osVersion: "13.6.9",
    });

    const result = await controller.probe();

    expect(result).toMatchObject({
      supported: true,
      available: false,
      status: "permission_required",
      permissions: {
        accessibility: "granted",
        screenRecording: "denied",
      },
    });
    expect(fake.sdk.currentMacOsPermissionStatus).toHaveBeenCalledOnce();
    expect(fake.sdk.CuaDriver.create).not.toHaveBeenCalled();
  });

  it("fails closed when the SDK surface does not match", async () => {
    const controller = createComputerUseController({
      platform: "win32",
      arch: "x64",
      osVersion: "10",
      loadSdk: async () => ({ CuaDriver: { create() {} } }),
    });

    const result = await controller.probe();

    expect(result).toMatchObject({
      supported: true,
      available: false,
      status: "sdk_api_mismatch",
    });
  });

  it("keeps the declared platform matrix narrow", () => {
    expect(probePlatform("win32", "x64", "10")).toBeNull();
    expect(probePlatform("win32", "arm64", "11")?.status).toBe("unsupported_arch");
    expect(probePlatform("linux", "x64", "6")?.status).toBe("unsupported_os");
  });
});

describe("computer-use sessions and windows", () => {
  it("starts a version-checked embedded session, sanitizes windows, and stops", async () => {
    const fake = makeFakeSdk({
      windows: [
        testWindow(),
        testWindow({ pid: 7, windowId: 2n, title: "Tongpin" }),
        testWindow({ pid: 44, windowId: 3n, minimized: true }),
        testWindow({ pid: 45, windowId: 4n, title: "" }),
      ],
    });
    const controller = makeController(fake);

    expect(await controller.listWindows()).toMatchObject({
      ok: false,
      error: { code: "session_not_active" },
    });
    expect(await controller.startSession()).toEqual({
      ok: true,
      value: {
        sessionId: "tongpin-test-session",
        state: "running",
        revived: false,
      },
    });
    const listed = await controller.listWindows();
    expect(listed).toEqual({
      ok: true,
      value: {
        windows: [
          {
            pid: 42,
            windowId: "9007199254740993",
            appName: "Notes",
            title: "Draft",
            bounds: { x: 20, y: 30, width: 800, height: 600 },
          },
        ],
      },
    });
    expect(await controller.stopSession()).toEqual({
      ok: true,
      value: { sessionId: null, state: "stopped" },
    });
    expect(fake.driver.endSession).toHaveBeenCalledWith(
      { session: "tongpin-test-session" },
      expect.any(Object),
    );
    expect(fake.driver.shutdown).toHaveBeenCalledOnce();
    expect(fake.driver.uniffiDestroy).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched native driver version and destroys it", async () => {
    const fake = makeFakeSdk({ driverVersion: "0.28.0" });
    const result = await makeController(fake).startSession();

    expect(result).toMatchObject({
      ok: false,
      error: { code: "sdk_version_mismatch" },
    });
    expect(fake.driver.startSession).not.toHaveBeenCalled();
    expect(fake.driver.shutdown).toHaveBeenCalledOnce();
    expect(fake.driver.uniffiDestroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the pinned runtime lacks element-targeted type_text", async () => {
    const fake = makeFakeSdk({ tools: [] });
    const result = await makeController(fake).startSession();

    expect(result).toMatchObject({
      ok: false,
      error: { code: "sdk_api_mismatch" },
    });
    expect(fake.driver.listToolsJson).toHaveBeenCalledOnce();
    expect(fake.driver.startSession).not.toHaveBeenCalled();
    expect(fake.driver.shutdown).toHaveBeenCalledOnce();
  });

  it("requires native consent before creating a driver or reading windows", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake, { confirmSession: async () => false });

    expect(await controller.startSession()).toMatchObject({
      ok: false,
      error: { code: "session_consent_denied" },
    });
    expect(fake.sdk.CuaDriver.create).not.toHaveBeenCalled();
    expect(fake.driver.listWindows).not.toHaveBeenCalled();
  });

  it("finishes stopping when cleanup races an in-progress native start", async () => {
    let finishStart;
    const fake = makeFakeSdk({
      startSession: async () => new Promise(resolve => { finishStart = resolve; }),
    });
    const controller = makeController(fake);
    const starting = controller.startSession();
    await vi.waitFor(() => expect(fake.driver.startSession).toHaveBeenCalledOnce());
    const stopping = controller.stopSession();
    finishStart({ active: true, revived: false });

    expect(await starting).toMatchObject({ ok: true });
    expect(await stopping).toEqual({ ok: true, value: { sessionId: null, state: "stopped" } });
    expect(await controller.listWindows()).toMatchObject({ ok: false, error: { code: "session_not_active" } });
    expect(fake.driver.shutdown).toHaveBeenCalledOnce();
  });

  it("does not silently reuse a running session", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake);
    expect(await controller.startSession()).toMatchObject({ ok: true });
    expect(await controller.startSession()).toMatchObject({ ok: false, error: { code: "session_busy" } });
    expect(fake.driver.startSession).toHaveBeenCalledOnce();
    await controller.stopSession();
  });

  it("captures one exact window with fixed in-memory bounds and no output path", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake);
    await controller.startSession();

    const result = await controller.getWindowState({
      pid: 42,
      windowId: "9007199254740993",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        contentTrust: "untrusted-observation",
        target: { pid: 42, windowId: "9007199254740993" },
        snapshotId: "snapshot-1",
        treeMarkdown: "- button: Save",
        elements: [
          {
            elementIndex: "1",
            role: "button",
            elementToken: "element-token-1",
            label: "Save",
          },
        ],
        screenshot: {
          mimeType: "image/png",
          dataBase64: "aGVsbG8=",
          width: 800,
          height: 600,
          frameValid: true,
        },
      },
    });
    expect(fake.calls.windowState[0]).toEqual({
      pid: 42,
      windowId: 9_007_199_254_740_993n,
      session: "tongpin-test-session",
      includeAccessibilityTree: true,
      includeScreenshot: true,
      maxElements: 160,
      maxDepth: 12,
      maxDimension: 1280,
    });
    expect(fake.calls.windowState[0]).not.toHaveProperty("screenshotOutFile");
    expect(fake.calls.windowState[0]).not.toHaveProperty("query");
    await controller.stopSession();
  });
});

describe("computer-use one-time action approval", () => {
  it("denies by default and exposes no generic SDK tool surface", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake);
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);

    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });

    expect(approval).toMatchObject({
      ok: false,
      error: { code: "approval_denied" },
    });
    expect(fake.driver.click).not.toHaveBeenCalled();
    expect(Object.keys(controller)).not.toContain("callTool");
    await controller.stopSession();
  });

  it("binds a click to a native approval, consumes its token once, and never retries", async () => {
    const fake = makeFakeSdk();
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    await controller.startSession();
    const action = {
      kind: "click",
      target: { pid: 42, windowId: "9007199254740993" },
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    };

    await controller.getWindowState(action.target);
    const approval = await controller.requestActionApproval(action);
    expect(approval.ok).toBe(true);
    expect(confirmAction).toHaveBeenCalledOnce();
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ action });
    expect(confirmAction.mock.calls[0][0].message).toContain("Save");

    const first = await controller.executeApprovedAction(approval.value.token);
    const replay = await controller.executeApprovedAction(approval.value.token);

    expect(first).toMatchObject({
      ok: true,
      value: { kind: "click", state: "delivered", effect: "Confirmed" },
    });
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(fake.driver.click).toHaveBeenCalledOnce();
    expect(fake.calls.click[0]).toMatchObject({
      target: {
        tag: "Window",
        inner: { pid: 42, windowId: 9_007_199_254_740_993n },
      },
      position: { tag: "Element", inner: { elementToken: "element-token-1" } },
      deliveryMode: 0,
      session: "tongpin-test-session",
      button: 0,
      count: 1,
    });
    expect(await controller.requestActionApproval(action)).toMatchObject({
      ok: false,
      error: { code: "target_changed" },
    });
    await controller.stopSession();
  });

  it("rejects an expired observation before opening the action confirmation", async () => {
    const fake = makeFakeSdk();
    let currentTime = 1_000;
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, {
      confirmAction,
      now: () => currentTime,
    });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    currentTime += SNAPSHOT_TTL_MS + 1;

    expect(await controller.requestActionApproval({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
      text: "仅输入文字",
    })).toMatchObject({ ok: false, error: { code: "snapshot_expired" } });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(fake.driver.typeText).not.toHaveBeenCalled();
    expect(fake.driver.callTool).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("fails closed on a refused native effect and consumes the approval", async () => {
    const fake = makeFakeSdk({ clickResult: { effect: 4, route: 1 } });
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });

    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "action_failed" },
    });
    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(fake.driver.click).toHaveBeenCalledOnce();
    await controller.stopSession();
  });

  it("expires approvals and consumes them even when execution is refused", async () => {
    const fake = makeFakeSdk();
    let currentTime = 1_000;
    const controller = makeController(fake, {
      confirmAction: async () => true,
      now: () => currentTime,
    });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });
    currentTime += APPROVAL_TTL_MS + 1;

    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "approval_expired" },
    });
    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("invalidates approval when the exact target window changes", async () => {
    let window = testWindow();
    const fake = makeFakeSdk({ windows: () => [window] });
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });
    window = testWindow({ bounds: { x: 21, y: 30, width: 800, height: 600 } });

    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "target_changed" },
    });
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("types only into an approved editable element and rebinds its fresh token", async () => {
    let capture = 0;
    const fake = makeFakeSdk({
      windowState: (input) => ({
        pid: input.pid,
        windowId: input.windowId,
        snapshotId: `snapshot-${++capture}`,
        appName: "Notes",
        windowTitle: "Draft",
        treeMarkdown: "- text field: Body",
        elements: [{
          elementIndex: 1n,
          role: "AXTextField",
          depth: 1,
          elementToken: `field-token-${capture}`,
          label: "Body",
          enabled: true,
        }],
        elementCount: 1n,
        elementsComplete: true,
        images: [],
      }),
    });
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };

    expect(await controller.requestActionApproval({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "field-token-1",
      text: "send now\n",
    })).toMatchObject({ ok: false, error: { code: "invalid_action" } });
    expect(confirmAction).not.toHaveBeenCalled();

    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "field-token-1",
      text: "仅输入文字",
    });
    expect(approval.value.summary).toContain("5 个字符");
    expect(approval.value.summary).not.toContain("仅输入文字");
    expect(confirmAction.mock.calls[0][0].message).toContain("Body");
    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: true,
      value: { kind: "type", state: "delivered", effect: "Confirmed" },
    });
    expect(fake.driver.typeText).not.toHaveBeenCalled();
    expect(fake.driver.callTool).toHaveBeenCalledOnce();
    expect(fake.calls.callTool[0].name).toBe("type_text");
    expect(fake.calls.callTool[0].argumentsJson).toContain('"window_id":9007199254740993');
    expect(JSON.parse(fake.calls.callTool[0].argumentsJson)).toMatchObject({
      text: "仅输入文字",
      target: {
        kind: "window",
        pid: 42,
      },
      element_token: "field-token-2",
      session: "tongpin-test-session",
      delivery_mode: "background",
    });
    await controller.stopSession();
  });

  it("scrolls and presses only allowlisted keys against a fresh element in the exact window", async () => {
    let capture = 0;
    const fake = makeFakeSdk({ windowState: input => ({
      pid: input.pid, windowId: input.windowId, snapshotId: `snapshot-${++capture}`,
      appName: "Notes", windowTitle: "Draft", treeMarkdown: "- list: Results",
      elements: [{ elementIndex: 1n, role: "list", depth: 1, elementToken: `list-${capture}`, label: "Results", enabled: true }],
      elementCount: 1n, elementsComplete: true, images: [],
    }) });
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    expect((await controller.startSession()).ok).toBe(true);
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const scroll = await controller.requestActionApproval({ kind: "scroll", target, snapshotId: "snapshot-1", elementToken: "list-1", direction: "down", amount: 2 });
    expect(scroll.ok).toBe(true);
    expect(confirmAction.mock.calls[0][0].message).toContain("滚动 2 格");
    expect(await controller.executeApprovedAction(scroll.value.token)).toMatchObject({ ok: true, value: { kind: "scroll" } });
    expect(fake.calls.callTool[0].name).toBe("scroll");
    expect(fake.calls.callTool[0].argumentsJson).toContain('"window_id":9007199254740993');
    expect(JSON.parse(fake.calls.callTool[0].argumentsJson)).toMatchObject({ direction: "down", by: "line", amount: 2,
      element_token: "list-2", delivery_mode: "background", target: { kind: "window", pid: 42 } });
    expect(await controller.executeApprovedAction(scroll.value.token)).toMatchObject({ ok: false, error: { code: "approval_required" } });
    await controller.getWindowState(target);
    const key = await controller.requestActionApproval({ kind: "key", target, snapshotId: "snapshot-3", elementToken: "list-3", key: "escape" });
    expect(key.ok).toBe(true);
    expect(await controller.executeApprovedAction(key.value.token)).toMatchObject({ ok: true, value: { kind: "key" } });
    expect(fake.calls.callTool[1].name).toBe("press_key");
    expect(JSON.parse(fake.calls.callTool[1].argumentsJson)).toMatchObject({ key: "escape", element_token: "list-4", delivery_mode: "background" });
    expect(fake.calls.callTool[1].argumentsJson).not.toContain("modifiers");
    await controller.stopSession();
  });

  it("fails closed when navigation tool schema, target or allowed key changes", async () => {
    const fake = makeFakeSdk({ tools: [{ name: "type_text", inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" }, element_token: { type: "string" }, target: {}, delivery_mode: { enum: ["background"] } } } }] });
    expect(await makeController(fake).startSession()).toMatchObject({ ok: false, error: { code: "sdk_api_mismatch" } });
    const valid = makeFakeSdk();
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(valid, { confirmAction });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    for (const action of [
      { kind: "key", target, snapshotId: "snapshot-1", elementToken: "element-token-1", key: "return" },
      { kind: "key", target, snapshotId: "snapshot-1", elementToken: "element-token-1", key: "down", modifiers: ["cmd"] },
      { kind: "scroll", target, snapshotId: "snapshot-1", elementToken: "element-token-1", direction: "down", amount: 50 },
      { kind: "scroll", target, snapshotId: "snapshot-1", elementToken: "element-token-1", direction: "down", amount: 1, scope: "desktop" },
    ]) expect(await controller.requestActionApproval(action)).toMatchObject({ ok: false, error: { code: "invalid_action" } });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(valid.driver.callTool).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("reports unavailable background delivery without foreground fallback or retry", async () => {
    const fake = makeFakeSdk({ typeResult: { isError: true, errorCode: "background_unavailable" } });
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "scroll", target, snapshotId: "snapshot-1", elementToken: "element-token-1", direction: "down", amount: 1,
    });
    expect(approval.ok).toBe(true);
    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false, error: { code: "background_unavailable" },
    });
    expect(fake.calls.callTool).toHaveLength(1);
    expect(JSON.parse(fake.calls.callTool[0].argumentsJson).delivery_mode).toBe("background");
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("rejects typing into a non-editable snapshot element before confirmation", async () => {
    const fake = makeFakeSdk();
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);

    expect(await controller.requestActionApproval({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
      text: "不应输入",
    })).toMatchObject({ ok: false, error: { code: "invalid_action" } });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(fake.driver.callTool).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("allows a snapshot-bound element click only after a fresh observation and approval", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    const action = {
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    };

    expect(await controller.requestActionApproval(action)).toMatchObject({
      ok: false,
      error: { code: "target_changed" },
    });
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval(action);
    expect(approval.ok).toBe(true);
    expect(approval.value.summary).toContain("Save");
    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: true,
      value: { kind: "click", effect: "Confirmed" },
    });
    expect(fake.calls.click.at(-1).position).toEqual({
      tag: "Element",
      inner: { elementToken: "element-token-1" },
    });
    await controller.stopSession();
  });

  it("re-observes after approval, rejects changed UI, and never invokes input", async () => {
    let capture = 0;
    const fake = makeFakeSdk({
      windowState: (input) => ({
        pid: input.pid,
        windowId: input.windowId,
        snapshotId: `snapshot-${++capture}`,
        appName: "Notes",
        windowTitle: "Draft",
        treeMarkdown: capture === 1 ? "- button: Save" : "- button: Delete",
        elements: [{
          elementIndex: 1n,
          role: "button",
          depth: 1,
          elementToken: `element-token-${capture}`,
          label: capture === 1 ? "Save" : "Delete",
          enabled: true,
        }],
        elementCount: 1n,
        elementsComplete: true,
        images: [],
      }),
    });
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });

    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({
      ok: false,
      error: { code: "target_changed" },
    });
    expect(fake.driver.getWindowState).toHaveBeenCalledTimes(2);
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });

  it("rebinds an unchanged approved element to its fresh ephemeral token", async () => {
    let capture = 0;
    const fake = makeFakeSdk({
      windowState: (input) => ({
        pid: input.pid,
        windowId: input.windowId,
        snapshotId: `snapshot-${++capture}`,
        appName: "Notes",
        windowTitle: "Draft",
        treeMarkdown: "- button: Save",
        elements: [{
          elementIndex: 1n,
          role: "button",
          depth: 1,
          elementToken: `element-token-${capture}`,
          label: "Save",
          enabled: true,
        }],
        elementCount: 1n,
        elementsComplete: true,
        images: [],
      }),
    });
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    const target = { pid: 42, windowId: "9007199254740993" };
    await controller.getWindowState(target);
    const approval = await controller.requestActionApproval({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-token-1",
    });

    expect(await controller.executeApprovedAction(approval.value.token)).toMatchObject({ ok: true });
    expect(fake.calls.click[0].position).toEqual({
      tag: "Element",
      inner: { elementToken: "element-token-2" },
    });
    await controller.stopSession();
  });
});

describe("computer-use action schema", () => {
  it("accepts only exact element actions, rejecting coordinates and extra authority", () => {
    const target = { pid: 42, windowId: "9" };
    expect(normalizeAction({ kind: "click", target, snapshotId: "snapshot-1", x: 1, y: 2 })).toBeNull();
    expect(normalizeAction({ kind: "type", target, snapshotId: "snapshot-1", elementToken: "field-1", text: "hello" })).toEqual({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "field-1",
      text: "hello",
    });
    expect(normalizeAction({ kind: "type", target, snapshotId: "snapshot-1", text: "hello" })).toBeNull();
    expect(normalizeAction({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-1",
    })).toEqual({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      elementToken: "element-1",
    });
    expect(normalizeAction({ kind: "shell", target, command: "whoami" })).toBeNull();
    expect(normalizeAction({ kind: "scroll", target, snapshotId: "snapshot-1", elementToken: "list-1", direction: "down", amount: 1 })).toMatchObject({ kind: "scroll", direction: "down", amount: 1 });
    expect(normalizeAction({ kind: "key", target, snapshotId: "snapshot-1", elementToken: "list-1", key: "left" })).toMatchObject({ kind: "key", key: "left" });
    expect(normalizeAction({
      kind: "click",
      target,
      snapshotId: "snapshot-1",
      x: 1,
      y: 2,
      button: "right",
    })).toBeNull();
    expect(normalizeAction({
      kind: "type",
      target,
      snapshotId: "snapshot-1",
      elementToken: "field-1",
      text: "hello",
      pressEnter: true,
    })).toBeNull();
  });
});

describe("computer-use Electron boundary", () => {
  it("exposes seven named IPC calls, checks the main frame, and exposes no generic tool", () => {
    const main = readFileSync(new URL("./main.cjs", import.meta.url), "utf8");
    const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
    const controller = readFileSync(new URL("./computer-use.cjs", import.meta.url), "utf8");
    const channels = [
      "probe",
      "start-session",
      "stop-session",
      "list-windows",
      "get-window-state",
      "request-action-approval",
      "execute-approved-action",
    ];

    for (const channel of channels) {
      const handlerStart = main.indexOf(`ipcMain.handle("computer-use:${channel}"`);
      expect(handlerStart).toBeGreaterThan(-1);
      expect(main.slice(handlerStart, handlerStart + 240)).toContain(
        "assertMainRendererEvent(event)",
      );
      expect(preload).toContain(`ipcRenderer.invoke("computer-use:${channel}"`);
    }
    expect(Object.keys(createComputerUseController())).not.toContain("callTool");
    expect(controller.match(/\.callTool\(/g)).toHaveLength(2);
    expect(controller).toContain('"type_text",');
    expect(controller).toContain('"scroll" : "press_key"');
    expect(controller).not.toContain('require("node:child_process")');
    expect(preload).not.toContain("computer-use:call-tool");
    expect(preload).not.toContain("computer-use:shell");
    expect(main).toContain("isAllowedMainRendererUrl(senderFrame.url)");
    expect(main).toContain('candidate.protocol !== "file:"');
    const mainNavigation = main.slice(
      main.indexOf('mainWindow.webContents.on("will-navigate"'),
      main.indexOf("if (isDevelopment)", main.indexOf('mainWindow.webContents.on("will-navigate"')),
    );
    expect(mainNavigation).not.toContain('url.startsWith("file://")');
  });
});

describe("computer-use main-process task bounds", () => {
  const action = { kind: "click", target: { pid: 42, windowId: "9007199254740993" }, snapshotId: "snapshot-1", elementToken: "element-token-1" };
  it("caps a native session at six execution attempts even if a renderer keeps asking", async () => {
    const fake = makeFakeSdk();
    const controller = makeController(fake, { confirmAction: async () => true });
    await controller.startSession();
    for (let index = 0; index < 6; index += 1) {
      await controller.getWindowState(action.target);
      const approved = await controller.requestActionApproval(action);
      expect(approved.ok).toBe(true);
      expect((await controller.executeApprovedAction(approved.value.token)).ok).toBe(true);
    }
    await controller.getWindowState(action.target);
    expect(await controller.requestActionApproval(action)).toMatchObject({ ok: false, error: { code: "session_not_active" } });
    expect(fake.driver.click).toHaveBeenCalledTimes(6);
    await controller.stopSession();
  });
  it("checks the native deadline after approval, before input", async () => {
    let now = 0;
    const fake = makeFakeSdk();
    const controller = makeController(fake, { now: () => now, confirmAction: async () => true });
    await controller.startSession();
    now = 299_000;
    await controller.getWindowState(action.target);
    const approved = await controller.requestActionApproval(action);
    now = 300_001;
    expect(await controller.executeApprovedAction(approved.value.token)).toMatchObject({ ok: false, error: { code: "session_not_active" } });
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });
  it("will not type into a password-labelled ordinary text field", async () => {
    const fake = makeFakeSdk();
    const original = fake.driver.getWindowState;
    fake.driver.getWindowState = vi.fn(async input => {
      const state = await original(input);
      return { ...state, elements: [{ elementIndex: 1n, role: "AXTextField", depth: 1, elementToken: "secret", label: "API Key 密钥" }] };
    });
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    await controller.startSession();
    await controller.getWindowState(action.target);
    expect(await controller.requestActionApproval({ ...action, kind: "type", elementToken: "secret", text: "abc" })).toMatchObject({ ok: false, error: { code: "invalid_action" } });
    expect(confirmAction).not.toHaveBeenCalled();
    expect(fake.driver.callTool).not.toHaveBeenCalled();
    await controller.stopSession();
  });
  it("pins the granted window and rejects changing targets inside the same session", async () => {
    const fake = makeFakeSdk({ windows: [testWindow(), testWindow({ pid: 43, windowId: 99n })] });
    const confirmAction = vi.fn(async () => true);
    const controller = makeController(fake, { confirmAction });
    await controller.startSession();
    await controller.getWindowState(action.target);
    expect((await controller.requestActionApproval(action)).ok).toBe(true);
    const otherTarget = { pid: 43, windowId: "99" };
    await controller.getWindowState(otherTarget);
    expect(await controller.requestActionApproval({ ...action, target: otherTarget })).toMatchObject({ ok: false, error: { code: "target_changed" } });
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(fake.driver.click).not.toHaveBeenCalled();
    await controller.stopSession();
  });
});
