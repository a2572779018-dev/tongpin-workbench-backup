import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ login: vi.fn() }),
  LocalSessionPersistenceError: class LocalSessionPersistenceError extends Error {},
}));

const { AuthPage } = await import("../pages/AuthPage");
const globalWithWindow = globalThis as { window?: unknown };

function checkbox(html: string, label: string) {
  const end = html.indexOf(`<b>${label}</b>`);
  expect(end).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<input", end);
  return html.slice(start, html.indexOf("/>", start) + 2);
}

describe("sign-in remember options", () => {
  afterEach(() => { delete globalWithWindow.window; });

  it("offers 记住账号 (on) and an opt-in 记住密码 (off) on the desktop app", () => {
    globalWithWindow.window = {
      tongpin: {
        platform: "darwin",
        credentials: { list: vi.fn(), save: vi.fn(), remove: vi.fn(), reveal: vi.fn() },
      },
    };
    const html = renderToStaticMarkup(createElement(AuthPage));
    expect(checkbox(html, "记住账号")).toContain('checked=""');
    expect(checkbox(html, "记住密码")).not.toContain("checked");
    expect(html).not.toContain("密码每次输入");
  });

  it("does not offer 记住密码 without the desktop vault (browser build)", () => {
    globalWithWindow.window = {};
    const html = renderToStaticMarkup(createElement(AuthPage));
    expect(html).toContain("<b>记住账号</b>");
    expect(html).not.toContain("记住密码");
  });
});
