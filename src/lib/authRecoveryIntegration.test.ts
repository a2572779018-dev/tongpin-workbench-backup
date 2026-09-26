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
const preload = readSource(
  new URL("../../electron/preload.cjs", import.meta.url),
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

  it("remembers a password only on explicit opt-in, inside the main-process vault", () => {
    expect(authPage).toContain('result.state');
    expect(authPage).toContain("本机账号记录暂时无法安全更新");
    expect(authPage).toContain("refreshRememberedAccounts");
    expect(authPage).toContain("<b>记住账号</b>");
    expect(authPage).toContain("<b>记住密码</b>");
    expect(authPage).toContain(
      "const [rememberPassword, setRememberPassword] = useState(false);",
    );
    // Passwords never touch renderer storage and are revealed only on selection.
    expect(authPage).not.toContain("localStorage");
    expect(authContext).not.toMatch(/localStorage[^\n]*password/i);
    expect(authPage).toContain("resolveRememberedPassword(");
    expect(authPage).not.toContain("credentials.load");
    expect(electronMain).not.toContain("credentials:load");
    expect(authContext).toContain("persistLoginCredentials(");
    expect(authPage).toContain("rememberPassword: false,");
  });

  it("guards the reveal IPC to the main window and the signed-out screen", () => {
    const reveal = electronMain.slice(
      electronMain.indexOf('ipcMain.handle("credentials:reveal"'),
      electronMain.indexOf('ipcMain.handle("relationship-graph:open"'),
    );
    expect(reveal).toContain("assertMainRendererEvent(event);");
    expect(reveal).toContain('if (typeof inMemorySessionPayload === "string")');
    expect(reveal).toContain("revealPassword(emailValue)");
    expect(electronMain).toContain(
      'process.platform === "darwin" || process.platform === "win32"',
    );
    expect(preload).toContain('ipcRenderer.invoke("credentials:reveal", String(email))');
    expect(electronMain).not.toMatch(/console\.[a-z]+\([^)]*password/i);
  });
});
