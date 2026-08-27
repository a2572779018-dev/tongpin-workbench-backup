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

  it("distinguishes an unreadable credential vault from an empty history", () => {
    expect(authPage).toContain('result.state');
    expect(authPage).toContain("登录钥匙串未解锁，账号记录仍安全保留");
    expect(authPage).toContain("系统安全存储暂不可用，账号记录仍安全保留");
    expect(authPage).toContain("refreshRememberedAccounts");
    expect(authPage).toContain("openSystemStorage");
    expect(electronMain).toContain("credentials:open-system-storage");
    expect(electronMain).toContain("Keychain Access.app");
    expect(authPage).toContain("该账号的安全密码暂时无法读取，请手动输入。");
  });
});
