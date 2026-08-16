const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PW_MODULE);

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "output");
const baseUrl = process.env.TONGPIN_PREVIEW_URL ?? "http://127.0.0.1:4173";
const reportDate = "2026-08-16";

const boss = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "boss.preview@tongpin.test",
  name: "BOSS",
  role: "boss",
  status: "active",
  jobTitle: "老板",
  avatarSeed: 0,
  avatarVersion: 0,
  hasCustomAvatar: false,
  emailVerifiedAt: "2026-08-01T00:00:00.000Z",
  lastLoginAt: "2026-08-16T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const employeeFixtures = [
  ["林舒", "产品经理", 5, 2, 1, 6, 8, 6, 2, 75],
  ["周野", "视觉设计", 3, 1, 2, 4, 6, 4, 1, 67],
  ["李薇", "运营经理", 4, 3, 0, 5, 7, 5, 1, 71],
  ["陈默", "开发工程师", 2, 0, 1, 2, 4, 2, 1, 50],
];

function member(fixture, index, multiplier = 1) {
  const [name, jobTitle, selfCreated, carriedOver, assigned, completed, scheduled,
    scheduledDone, doing, completionRate] = fixture;
  return {
    user: {
      ...boss,
      id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
      email: `member${index + 1}@tongpin.test`,
      name,
      role: "member",
      jobTitle,
      avatarSeed: index + 1,
    },
    selfCreated: selfCreated * multiplier,
    carriedOver: carriedOver * multiplier,
    assigned: assigned * multiplier,
    completed: completed * multiplier,
    scheduled: scheduled * multiplier,
    scheduledDone: scheduledDone * multiplier,
    doing: doing * multiplier,
    completionRate,
  };
}

function section(kind, startDate, endDate, multiplier) {
  const members = employeeFixtures.map((fixture, index) =>
    member(fixture, index, multiplier),
  );
  const totals = members.reduce(
    (result, item) => {
      for (const key of [
        "selfCreated", "carriedOver", "assigned", "completed", "scheduled",
        "scheduledDone", "doing",
      ]) result[key] += item[key];
      return result;
    },
    {
      people: members.length,
      activePeople: members.length,
      selfCreated: 0,
      carriedOver: 0,
      assigned: 0,
      completed: 0,
      scheduled: 0,
      scheduledDone: 0,
      doing: 0,
      completionRate: 0,
    },
  );
  totals.completionRate = Math.round(
    (totals.scheduledDone / totals.scheduled) * 100,
  );
  return { period: { kind, startDate, endDate }, summary: totals, members };
}

const report = {
  reportDate,
  generatedAt: "2026-08-16T00:01:00.000Z",
  status: {
    bossUserId: boss.id,
    reportDate,
    trigger: "startup",
    openedAt: "2026-08-16T00:01:00.000Z",
    dismissedAt: null,
    readAt: null,
  },
  daily: section("daily", "2026-08-15", "2026-08-15", 1),
  weekly: section("weekly", "2026-08-03", "2026-08-09", 4),
  monthly: section("monthly", "2026-07-01", "2026-07-31", 14),
};

const session = {
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  user: boss,
};

const memberSession = {
  accessToken: "member-fixture-access-token",
  refreshToken: "member-fixture-refresh-token",
  user: employeeFixtures.length
    ? member(employeeFixtures[0], 0).user
    : boss,
};

const nudgeNotification = {
  id: "33333333-3333-4333-8333-333333333333",
  dispatchId: "44444444-4444-4444-8444-444444444444",
  senderId: boss.id,
  recipientId: memberSession.user.id,
  title: "老板提醒您",
  body: "昨日任务不要忘记完成哦",
  requiresAcknowledgement: true,
  deliveredAt: null,
  acknowledgedAt: null,
  dingCount: 0,
  lastDingAt: null,
  readAt: null,
  createdAt: "2026-08-16T00:02:00.000Z",
};

async function verifySize(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const runtimeErrors = [];
  const requestFailures = [];
  let reportClaimed = false;
  let currentReport = structuredClone(report);
  let nudgeRequests = 0;
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push(`${request.method()} ${request.url()}`);
  });

  await page.addInitScript(({ persistedSession }) => {
    window.localStorage.setItem("tongpin:last-announced-release", "0.1.20");
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
            this.dispatchEvent(new MessageEvent("message", {
              data: JSON.stringify({
                type: "realtime:ready",
                data: { connected: true, heartbeat: true },
              }),
            }));
          }, 0);
        } else if (message.type === "ping") {
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "pong" }),
          }));
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
      versions: { app: "0.1.20", electron: "43.2.0" },
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
      onSystemResume: () => () => undefined,
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
    if (url.pathname === "/api/auth/me") body = { user: boss };
    else if (url.pathname === "/api/notifications") body = { notifications: [] };
    else if (url.pathname === "/api/contacts") body = { unread: 0 };
    else if (url.pathname === "/api/tasks/assignments/pending") body = { assignments: [] };
    else if (url.pathname === "/api/tasks/summary") body = { summary: {} };
    else if (url.pathname === "/api/tasks/rollover") {
      body = { sourceDate: "2026-08-15", targetDate: reportDate, pending: false, tasks: [] };
    } else if (url.pathname === "/api/tasks") body = { tasks: [] };
    else if (url.pathname === "/api/boss/lora-chain/daily-popup/claim") {
      body = { shouldOpen: false, reportDate };
    } else if (url.pathname === "/api/boss/work-reports/claim") {
      body = { shouldOpen: !reportClaimed, report: currentReport };
      reportClaimed = true;
    } else if (url.pathname === "/api/boss/work-reports/nudge") {
      nudgeRequests += 1;
      body = {
        notification: {
          id: "33333333-3333-4333-8333-333333333333",
          dispatchId: "44444444-4444-4444-8444-444444444444",
          senderId: boss.id,
          recipientId: JSON.parse(route.request().postData() ?? "{}").userId,
          title: "老板提醒您",
          body: "昨日任务不要忘记完成哦",
          requiresAcknowledgement: true,
          deliveredAt: null,
          acknowledgedAt: null,
          dingCount: 0,
          lastDingAt: null,
          readAt: null,
          createdAt: "2026-08-16T00:02:00.000Z",
        },
      };
    } else if (url.pathname === "/api/boss/work-reports/current/dismiss") {
      currentReport = {
        ...currentReport,
        status: {
          ...currentReport.status,
          dismissedAt: "2026-08-16T00:02:00.000Z",
        },
      };
      body = { report: currentReport };
    } else if (url.pathname === "/api/boss/work-reports/current/read") {
      currentReport = {
        ...currentReport,
        status: {
          ...currentReport.status,
          dismissedAt: currentReport.status.dismissedAt ?? "2026-08-16T00:03:00.000Z",
          readAt: "2026-08-16T00:03:00.000Z",
        },
      };
      body = { report: currentReport };
    } else if (url.pathname === "/api/boss/work-reports/current") {
      body = { report: currentReport };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".work-report-dialog", { timeout: 15_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content: "* { animation: none !important; transition: none !important; }",
  });
  await page.waitForTimeout(200);
  const result = await page.evaluate(() => {
    const dialog = document.querySelector(".work-report-dialog");
    if (!dialog) throw new Error("work report dialog missing");
    const rect = dialog.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      dialog: {
        top: Math.floor(rect.top),
        left: Math.floor(rect.left),
        right: Math.ceil(rect.right),
        bottom: Math.ceil(rect.bottom),
      },
      tabs: document.querySelectorAll(".work-report-tabs button").length,
      employees: document.querySelectorAll(".work-report-member").length,
      donutCharts: document.querySelectorAll(".work-report-donut").length,
      nudgeButtons: document.querySelectorAll(".work-report-member__nudge").length,
      hasCarryoverText: document.querySelector(".work-report-dialog")
        ?.textContent?.includes("往日同步") ?? false,
      hasReadButton: [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.includes("我已阅读"),
      ),
      hasDesktopNotice: Boolean(document.querySelector(".notice-orb")),
      hasErrorOverlay: Boolean(
        document.querySelector(".vite-error-overlay, #webpack-dev-server-client-overlay"),
      ),
    };
  });
  if (result.documentWidth > width) throw new Error(`${width}x${height} horizontal overflow`);
  if (
    result.dialog.top < 0 ||
    result.dialog.left < 0 ||
    result.dialog.right > width ||
    result.dialog.bottom > height
  ) throw new Error(`${width}x${height} dialog clipped`);
  if (
    result.tabs !== 0 ||
    result.employees !== 4 ||
    result.donutCharts !== 2 ||
    result.nudgeButtons !== 4 ||
    result.hasCarryoverText ||
    !result.hasReadButton ||
    result.hasDesktopNotice ||
    result.hasErrorOverlay ||
    runtimeErrors.length > 0 ||
    requestFailures.length > 0
  ) {
    throw new Error(`${width}x${height} runtime verification failed: ${JSON.stringify({
      result,
      runtimeErrors,
      requestFailures,
    })}`);
  }
  const screenshot = path.join(outputDir, `work-report-${width}x${height}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  await page.locator(".work-report-member__nudge").first().click();
  await page.getByRole("button", { name: "已催办" }).waitFor();
  if (nudgeRequests !== 1) throw new Error(`${width}x${height} nudge request missing`);
  await page.locator(".work-report-close").click();
  await page.waitForSelector(".work-report-dialog", { state: "hidden" });
  await page.locator(".notification-button").click();
  await page.waitForSelector(".work-report-pending");
  const retainedInBell = await page.locator(".work-report-pending").isVisible();
  await page.locator(".work-report-pending button").click();
  await page.waitForSelector(".work-report-dialog");
  await page.getByRole("button", { name: "我已阅读" }).click();
  await page.waitForSelector(".work-report-dialog", { state: "hidden" });
  const clearedAfterRead = await page.locator(".notification-button > span").count() === 0;
  if (!retainedInBell || !clearedAfterRead) {
    throw new Error(`${width}x${height} close/read lifecycle failed`);
  }
  await context.close();
  return {
    ...result,
    nudgeDelivered: nudgeRequests === 1,
    retainedInBell,
    clearedAfterRead,
    screenshot,
  };
}

async function verifyMemberNudge(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(({ persistedSession }) => {
    window.localStorage.setItem("tongpin:last-announced-release", "0.1.20");
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
          setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({
              type: "realtime:ready",
              data: { connected: true, heartbeat: true },
            }),
          })), 0);
        } else if (message.type === "ping") {
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "pong" }),
          }));
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
      versions: { app: "0.1.20", electron: "43.2.0" },
      session: {
        load: async () => JSON.stringify(persistedSession),
        save: async () => undefined,
        clear: async () => undefined,
      },
      credentials: {
        list: async () => [], load: async () => null,
        save: async () => true, remove: async () => true,
      },
      notify: async () => true,
      dismissNotification: async () => true,
      openLoraExplorer: async () => true,
      onDesktopNoticeAcknowledge: () => () => undefined,
      onDesktopNoticeDismiss: () => () => undefined,
      onDesktopNoticeAction: () => () => undefined,
      onSystemResume: () => () => undefined,
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
  }, { persistedSession: memberSession });
  await page.route("http://127.0.0.1:4318/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === "/api/auth/me") body = { user: memberSession.user };
    else if (url.pathname === "/api/notifications") {
      body = { notifications: [nudgeNotification] };
    } else if (url.pathname.endsWith("/delivered")) {
      body = {
        notification: {
          ...nudgeNotification,
          deliveredAt: "2026-08-16T00:02:01.000Z",
        },
      };
    } else if (url.pathname === "/api/contacts") body = { unread: 0 };
    else if (url.pathname === "/api/tasks/assignments/pending") body = { assignments: [] };
    else if (url.pathname === "/api/tasks/summary") body = { summary: {} };
    else if (url.pathname === "/api/tasks/rollover") {
      body = { sourceDate: "2026-08-15", targetDate: reportDate, pending: false, tasks: [] };
    } else if (url.pathname === "/api/tasks") body = { tasks: [] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".strong-reminder", { timeout: 15_000 });
  await page.addStyleTag({
    content: "* { animation: none !important; transition: none !important; }",
  });
  const result = await page.evaluate(() => ({
    title: document.querySelector(".strong-reminder h2")?.textContent?.trim(),
    body: document.querySelector(".strong-reminder p")?.textContent?.trim(),
    hasConfirm: [...document.querySelectorAll("button")].some(
      (button) => button.textContent?.includes("确认收到"),
    ),
    documentWidth: document.documentElement.scrollWidth,
  }));
  if (
    result.title !== "老板提醒您" ||
    result.body !== "昨日任务不要忘记完成哦" ||
    !result.hasConfirm ||
    result.documentWidth > 1280 ||
    runtimeErrors.length > 0
  ) {
    throw new Error(`member nudge preview failed: ${JSON.stringify({ result, runtimeErrors })}`);
  }
  const screenshot = path.join(outputDir, "work-report-nudge-member-1280x720.png");
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return { ...result, screenshot };
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
    const memberNudge = await verifyMemberNudge(browser);
    process.stdout.write(
      `${JSON.stringify({ verified: true, results, memberNudge }, null, 2)}\n`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
