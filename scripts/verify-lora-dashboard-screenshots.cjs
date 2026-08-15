const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PW_MODULE);

const projectRoot = path.resolve(__dirname, "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "lora-dashboard.json"), "utf8"),
);
const outputDir = path.join(projectRoot, "output");
const baseUrl = process.env.TONGPIN_PREVIEW_URL ?? "http://127.0.0.1:4173";
const session = {
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "boss.fixture@tongpin.test",
    name: "BOSS",
    role: "boss",
    status: "active",
    jobTitle: "老板",
    avatarSeed: 0,
    avatarVersion: 0,
    hasCustomAvatar: false,
    emailVerifiedAt: "2026-08-01T00:00:00.000Z",
    lastLoginAt: "2026-08-14T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z"
  }
};

async function verifySize(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const runtimeErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${request.url()}`);
  });
  await page.addInitScript(({ persistedSession }) => {
    try {
      window.localStorage.setItem("tongpin:last-announced-release", "0.1.19");
    } catch {
      // The fixture still works when storage is unavailable.
    }
    class FixtureWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = FixtureWebSocket.CONNECTING;
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = FixtureWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }
      send(raw) {
        const message = JSON.parse(String(raw));
        if (message.type === "auth") {
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "realtime:ready",
                  data: { connected: true, heartbeat: true },
                }),
              }),
            );
          }, 0);
        } else if (message.type === "ping") {
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ type: "pong" }) }),
          );
        }
      }
      close() {
        this.readyState = FixtureWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = FixtureWebSocket;
    window.tongpin = {
      apiUrl: "http://127.0.0.1:4318",
      platform: "win32",
      versions: { app: "0.1.19", electron: "43.2.0" },
      session: {
        load: async () => JSON.stringify(persistedSession),
        save: async () => undefined,
        clear: async () => undefined,
      },
      credentials: {
        list: async () => [],
        load: async () => null,
        save: async () => true,
        remove: async () => true,
      },
      notify: async () => true,
      dismissNotification: async () => true,
      openLoraExplorer: async () => true,
      onDesktopNoticeAcknowledge: () => () => undefined,
      onDesktopNoticeDismiss: () => () => undefined,
      onDesktopNoticeAction: () => () => undefined,
      installUpdate: async () => false,
      windowControls: {
        minimize: async () => undefined,
        toggleMaximize: async () => false,
        close: async () => undefined,
        isMaximized: async () => false,
        onMaximizedChange: () => () => undefined,
      },
      onUpdaterStatus: () => () => undefined,
    };
  }, { persistedSession: session });

  await page.route("http://127.0.0.1:4318/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === "/api/auth/me") body = { user: session.user };
    else if (url.pathname === "/api/notifications") body = { notifications: [] };
    else if (url.pathname === "/api/contacts") body = { unread: 0 };
    else if (url.pathname === "/api/tasks/assignments/pending") body = { assignments: [] };
    else if (url.pathname === "/api/boss/lora-chain/dashboard") body = fixture;
    else if (url.pathname === "/api/boss/lora-chain/daily-popup/claim") {
      body = { shouldOpen: true, reportDate: fixture.reportDate, dashboard: fixture };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lora-dashboard-page", { timeout: 15_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; }" });
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const dashboard = document.querySelector(".lora-dashboard-page");
    const kpis = document.querySelector(".lora-kpi-grid");
    const charts = document.querySelector(".lora-chart-grid");
    const tables = document.querySelector(".lora-table-grid");
    if (!dashboard || !kpis || !charts || !tables) throw new Error("dashboard structure missing");
    const dashboardRect = dashboard.getBoundingClientRect();
    const chartsRect = charts.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      dashboardBottom: Math.ceil(dashboardRect.bottom),
      chartsBottom: Math.ceil(chartsRect.bottom),
      kpiCount: kpis.children.length,
      chartCount: charts.children.length,
      tableCount: tables.children.length,
      tableScrollContained: [...tables.querySelectorAll(".lora-data-rows")].every(
        (element) => getComputedStyle(element).overflowY === "auto",
      ),
      dashboardSmallCount: dashboard.querySelectorAll("small").length,
      hasErrorOverlay: Boolean(
        document.querySelector(
          "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
        ),
      ),
      bodyTextLength: document.body.innerText.trim().length,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      appView: document.documentElement.dataset.appView,
    };
  });
  if (result.documentWidth > width) throw new Error(`${width}x${height} horizontal overflow`);
  if (result.dashboardBottom > height) throw new Error(`${width}x${height} dashboard clipped`);
  if (result.chartsBottom > height) throw new Error(`${width}x${height} core charts not visible`);
  if (result.kpiCount !== 6 || result.chartCount !== 3 || result.tableCount !== 2) {
    throw new Error(`${width}x${height} dashboard sections missing`);
  }
  if (!result.tableScrollContained || result.dashboardSmallCount !== 0) {
    throw new Error(`${width}x${height} table/small-text policy failed`);
  }
  if (
    result.hasErrorOverlay ||
    result.bodyTextLength === 0 ||
    runtimeErrors.length > 0 ||
    requestFailures.length > 0
  ) {
    throw new Error(
      `${width}x${height} runtime verification failed: ${JSON.stringify({
        runtimeErrors,
        requestFailures,
        hasErrorOverlay: result.hasErrorOverlay,
        bodyTextLength: result.bodyTextLength,
      })}`,
    );
  }
  if (result.bodyBackground !== "rgb(23, 35, 60)" || result.appView !== "lora-chain") {
    throw new Error(`${width}x${height} palette/view policy failed`);
  }
  const screenshot = path.join(outputDir, `lora-dashboard-${width}x${height}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return {
    ...result,
    consoleErrors: runtimeErrors.length,
    requestFailures: requestFailures.length,
    screenshot,
  };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath =
    process.env.CHROME_EXECUTABLE || (fs.existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const results = [];
    for (const [width, height] of [[1280, 720], [1440, 900]]) {
      results.push(await verifySize(browser, width, height));
    }
    process.stdout.write(`${JSON.stringify({ verified: true, results }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
