// Real app rendering and controller; only the account/API/WebSocket transport is synthetic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PW_MODULE);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/lora-dashboard.json"), "utf8"));
fixture.nodes.todayCount = "0";
fixture.nodes.hourly = Array.from({ length: 24 }, (_, hour) => ({ hour: String(hour).padStart(2, "0"), count: "0" }));
const session = { accessToken: "fixture", refreshToken: "fixture", user: {
  id: "11111111-1111-4111-8111-111111111111", email: "boss@tongpin.test", name: "Fixture Boss", role: "boss", status: "active", jobTitle: "老板",
  avatarSeed: 0, avatarVersion: 0, hasCustomAvatar: false, emailVerifiedAt: fixture.generatedAt,
  lastLoginAt: fixture.generatedAt, createdAt: fixture.generatedAt, updatedAt: fixture.generatedAt,
} };

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let dashboard = structuredClone(fixture), refresh = structuredClone(fixture), gets = 0;
    let nextGetFailure = false;
    await page.addInitScript(({ persistedSession }) => {
      class FixtureWebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        constructor() { super(); window.__loraFixtureSocket = this; setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
        send(raw) {
          const message = JSON.parse(raw);
          if (message.type === "auth") setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "realtime:ready", data: { connected: true, heartbeat: true } }) })), 0);
          if (message.type === "ping") this.dispatchEvent(new MessageEvent("message", { data: '{"type":"pong"}' }));
        }
        close() { this.readyState = 3; }
      }
      window.WebSocket = FixtureWebSocket;
      window.tongpin = {
        apiUrl: "http://127.0.0.1:4318", platform: "win32", versions: { app: "0.1.51", electron: "43" },
        session: { load: async () => JSON.stringify(persistedSession), save: async () => undefined, clear: async () => undefined },
        credentials: { list: async () => [], load: async () => null, save: async () => true, remove: async () => true },
        notify: async () => true, dismissNotification: async () => true, openLoraExplorer: async () => true,
        onDesktopNoticeAcknowledge: () => () => {}, onDesktopNoticeDismiss: () => () => {}, onDesktopNoticeAction: () => () => {},
        installUpdate: async () => false, onUpdaterStatus: () => () => {},
        windowControls: { minimize: async () => {}, toggleMaximize: async () => false, close: async () => {}, isMaximized: async () => false, onMaximizedChange: () => () => {} },
      };
    }, { persistedSession: session });
    await page.route("http://127.0.0.1:4318/api/**", async route => {
      const url = new URL(route.request().url());
      let body = {};
      if (url.pathname === "/api/auth/me") body = { user: session.user };
      else if (url.pathname === "/api/notifications") body = { notifications: [] };
      else if (url.pathname === "/api/contacts") body = { unread: 0 };
      else if (url.pathname === "/api/tasks/assignments/pending") body = { assignments: [] };
      else if (url.pathname === "/api/boss/lora-chain/daily-popup/claim") body = { shouldOpen: true, reportDate: fixture.reportDate, dashboard: fixture };
      else if (url.pathname === "/api/boss/lora-chain/dashboard") {
        gets++;
        if (nextGetFailure) { nextGetFailure = false; await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "fixture permission failure", code: "FORBIDDEN" } }) }); return; }
        body = dashboard;
      } else if (url.pathname === "/api/boss/lora-chain/refresh") body = { dashboard: refresh };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const push = payload => page.evaluate(data => window.__loraFixtureSocket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "lora-chain:updated", data }),
    })), payload);
    const noGlobalError = async () => assert.equal(await page.getByRole("heading", { name: "界面加载失败", exact: true }).count(), 0);
    await page.goto(process.env.TONGPIN_PREVIEW_URL ?? "http://127.0.0.1:5186", { waitUntil: "domcontentloaded" });
    await page.locator(".lora-dashboard-page").waitFor();
    await page.locator('.lora-hourly-line[aria-label*="峰值 00 时 0"]').waitFor();
    await noGlobalError();
    results.push("all-zero node day renders in the real app shell");

    refresh = { reportDate: fixture.reportDate };
    await page.getByRole("button", { name: "刷新 LORA 链数据", exact: true }).click();
    await page.getByText("链上数据暂时无法读取，请稍后刷新。", { exact: true }).waitFor();
    assert.ok((await page.locator(".lora-dashboard-page").innerText()).includes("销毁 3000 LRB"));
    await noGlobalError();
    results.push("malformed refresh preserves the last complete snapshot");

    dashboard = { ...fixture, generatedAt: "2026-08-14T03:00:00.000Z", nodes: { ...fixture.nodes, todayNodeBurnLrb: "7000" } };
    const before = gets;
    await push({ reportDate: fixture.reportDate });
    await page.locator(".lora-kpi-grid").getByText("销毁 7000 LRB", { exact: true }).waitFor();
    assert.ok(gets > before);
    await noGlobalError();
    results.push("malformed realtime event refetches and recovers");

    await push(fixture);
    assert.ok((await page.locator(".lora-dashboard-page").innerText()).includes("销毁 7000 LRB"));
    results.push("older data cannot overwrite a newer realtime snapshot");

    nextGetFailure = true;
    await push({ reportDate: fixture.reportDate });
    await page.getByText("fixture permission failure", { exact: true }).waitFor();
    await noGlobalError();
    results.push("HTTP permission errors stay inside the dashboard");

    await context.close();
    const recovery = await browser.newPage();
    await recovery.goto(`${process.env.TONGPIN_PREVIEW_URL ?? "http://127.0.0.1:5186"}/scripts/lora-dashboard-boundary.html`);
    await recovery.getByText("LORA 驾驶舱暂时无法显示", { exact: true }).waitFor();
    assert.equal(await recovery.getByText("外壳导航仍可用", { exact: true }).count(), 1);
    await recovery.getByRole("button", { name: "修复夹具", exact: true }).click();
    await recovery.getByRole("button", { name: "重新加载驾驶舱", exact: true }).click();
    await recovery.getByText("驾驶舱已恢复", { exact: true }).waitFor();
    results.push("local render boundary preserves the shell and retry remounts successfully");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: results.length, results, transport: "synthetic", browser: "Chrome on macOS; win32 bridge fixture", productionWrites: 0 }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
