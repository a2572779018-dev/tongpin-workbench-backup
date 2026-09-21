import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

const electronMain = readSource(
  new URL("../../electron/main.cjs", import.meta.url),
);
const authContext = readSource(
  new URL("../auth/AuthContext.tsx", import.meta.url),
);
const authPage = readSource(
  new URL("../pages/AuthPage.tsx", import.meta.url),
);

describe("cross-platform login recovery", () => {
  it("accepts the same underlying Electron main frame across wrapper objects", () => {
    expect(electronMain).toContain(
      "senderFrame.processId === mainFrame.processId",
    );
    expect(electronMain).toContain(
      "senderFrame.frameToken === mainFrame.frameToken",
    );
    expect(electronMain).not.toContain(
      "event?.senderFrame === mainWindow.webContents.mainFrame",
    );
  });

  it("does not let a packaged Windows environment variable replace the company API", () => {
    expect(electronMain).toContain(
      "if (!app.isPackaged && process.env.TONGPIN_API_URL)",
    );
    expect(electronMain).toContain(
      "!app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL)",
    );
    expect(electronMain).toContain('"https://notify.samhubs.com"');
  });

  it("separates local secure-session failures from API failures", () => {
    expect(authContext).toContain("LocalSessionPersistenceError");
    expect(authContext).toContain("throw new LocalSessionPersistenceError()");
    expect(authPage).toContain(
      "caught instanceof LocalSessionPersistenceError",
    );
    expect(authPage).not.toContain(
      "无法连接服务器，请确认 API 已启动。",
    );
  });

  it("keeps a successful login in memory when system secure storage is locked", () => {
    expect(electronMain).toContain("let inMemorySessionPayload = null");
    expect(electronMain).toContain(
      'typeof inMemorySessionPayload === "string"',
    );
    expect(electronMain).toContain("inMemorySessionPayload = payload");
    expect(electronMain).toContain('"memory-only\\n"');
    expect(electronMain).toContain("hasSessionMemoryOnlyMarker()");
    expect(electronMain).toContain("clearSessionMemoryOnlyMarker()");
    expect(electronMain).toContain(
      "安全存储锁定时只保留当前进程内的登录状态，绝不降级为明文落盘",
    );
    expect(electronMain).not.toContain(
      "系统安全存储不可用，拒绝明文保存登录状态",
    );
    expect(electronMain.indexOf("JSON.parse(payload)")).toBeLessThan(
      electronMain.indexOf("inMemorySessionPayload = payload"),
    );
  });

  it("keeps remembered accounts password-free and requires explicit password input", () => {
    expect(authPage).toContain('result.state');
    expect(authPage).toContain("本机账号记录暂时无法安全更新");
    expect(authPage).toContain("refreshRememberedAccounts");
    expect(authPage).toContain("密码每次输入");
    expect(authPage).not.toContain("credentials.load");
    expect(electronMain).not.toContain("credentials:load");
  });
});
