import { describe, expect, it, vi } from "vitest";
import {
  PASSWORD_NOT_SAVED_NOTICE,
  persistLoginCredentials,
  rememberedAccountHint,
  resolveRememberedPassword,
  revealFailureMessage,
} from "./rememberedLogin";

const SECRET = "Fixture-Pass-9x!";
const remembered = { email: "member@example.com", lastUsedAt: "2026-09-26T01:00:00.000Z", passwordRemembered: true };

describe("remembered-account autofill", () => {
  it("autofills only after an explicit selection of an account with a remembered password", async () => {
    const reveal = vi.fn(async () => ({ state: "ready" as const, password: SECRET }));
    await expect(resolveRememberedPassword({ reveal }, remembered, "darwin")).resolves.toEqual({
      password: SECRET, rememberPassword: true, message: "", refresh: false,
    });
    expect(reveal).toHaveBeenCalledWith("member@example.com");

    const accountOnly = { ...remembered, passwordRemembered: false };
    await expect(resolveRememberedPassword({ reveal }, accountOnly)).resolves.toEqual({
      password: "", rememberPassword: false, message: "", refresh: false,
    });
    expect(reveal).toHaveBeenCalledTimes(1);
    // A browser build has no desktop vault and never asks for a password.
    await expect(resolveRememberedPassword(undefined, remembered)).resolves.toMatchObject({ password: "", rememberPassword: false });
  });

  it("explains a locked macOS Keychain once and keeps the opt-in for re-saving", async () => {
    const reveal = vi.fn(async () => ({ state: "unavailable" as const, reason: "locked" as const }));
    const mac = await resolveRememberedPassword({ reveal }, remembered, "darwin");
    expect(mac).toMatchObject({ password: "", rememberPassword: true, refresh: false });
    expect(mac.message).toContain("钥匙串");
    expect(mac.message).toContain("始终允许");
    const windows = await resolveRememberedPassword({ reveal }, remembered, "win32");
    expect(windows.message).toBe("系统安全存储暂不可用，暂时无法读取保存的密码，请手动输入。");
    expect(windows.message).not.toContain("钥匙串");
  });

  it("reports a dropped unreadable secret, keeps the email flow and reloads the list", async () => {
    const reveal = vi.fn(async () => ({ state: "unavailable" as const, reason: "unreadable" as const }));
    const result = await resolveRememberedPassword({ reveal }, remembered, "darwin");
    expect(result).toMatchObject({ password: "", rememberPassword: true, refresh: true });
    expect(result.message).toContain("已删除，账号仍保留");
    expect(revealFailureMessage({ state: "unavailable", reason: "unreadable" }, "win32")).toBe(result.message);
  });

  it("never throws or leaks an IPC error into the form", async () => {
    const reveal = vi.fn(async () => { throw new Error(`ipc failure ${SECRET}`); });
    const result = await resolveRememberedPassword({ reveal }, remembered, "win32");
    expect(result.password).toBe("");
    expect(result.message).not.toContain(SECRET);
    expect(result.message).not.toContain("ipc");
    const missing = vi.fn(async () => ({ state: "missing" as const }));
    await expect(resolveRememberedPassword({ reveal: missing }, remembered)).resolves.toEqual({
      password: "", rememberPassword: false, message: "", refresh: true,
    });
    const signedIn = vi.fn(async () => ({ state: "unavailable" as const, reason: "session-active" as const }));
    await expect(resolveRememberedPassword({ reveal: signedIn }, remembered)).resolves.toMatchObject({ password: "", message: "" });
  });

  it("labels remembered accounts in the picker", () => {
    expect(rememberedAccountHint(remembered)).toBe("已记住密码");
    expect(rememberedAccountHint({ ...remembered, passwordRemembered: false })).toBe("仅记住账号");
    expect(rememberedAccountHint({ email: "x@example.com", lastUsedAt: "" })).toBe("仅记住账号");
  });
});

describe("credentials persisted after a successful login", () => {
  const bridge = () => ({
    save: vi.fn(async (payload: { email: string; password?: string; rememberPassword?: boolean }) =>
      ({ saved: true as const, password: payload.rememberPassword ? "stored" as const : "cleared" as const })),
    remove: vi.fn(async () => true),
  });

  it("sends the password to the vault only when 记住密码 is checked", async () => {
    const credentials = bridge();
    await expect(persistLoginCredentials(credentials, { email: "member@example.com", password: SECRET, rememberAccount: true, rememberPassword: true }))
      .resolves.toEqual({ notice: "" });
    expect(credentials.save).toHaveBeenCalledWith({ email: "member@example.com", password: SECRET, rememberPassword: true });

    const accountOnly = bridge();
    await persistLoginCredentials(accountOnly, { email: "member@example.com", password: SECRET, rememberAccount: true, rememberPassword: false });
    expect(accountOnly.save).toHaveBeenCalledWith({ email: "member@example.com", rememberPassword: false });
    expect(JSON.stringify(accountOnly.save.mock.calls)).not.toContain(SECRET);
  });

  it("forgets account and password when 记住账号 is unchecked, even if 记住密码 was left on", async () => {
    const credentials = bridge();
    await persistLoginCredentials(credentials, { email: "member@example.com", password: SECRET, rememberAccount: false, rememberPassword: true });
    expect(credentials.remove).toHaveBeenCalledWith("member@example.com");
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it("never blocks sign-in and explains a password that could not be stored", async () => {
    const unavailable = { save: vi.fn(async () => ({ saved: true as const, password: "unavailable" as const })), remove: vi.fn() };
    await expect(persistLoginCredentials(unavailable, { email: "a@example.com", password: SECRET, rememberAccount: true, rememberPassword: true }))
      .resolves.toEqual({ notice: PASSWORD_NOT_SAVED_NOTICE });
    const legacyMain = { save: vi.fn(async () => true), remove: vi.fn() };
    await expect(persistLoginCredentials(legacyMain, { email: "a@example.com", password: SECRET, rememberAccount: true, rememberPassword: true }))
      .resolves.toEqual({ notice: PASSWORD_NOT_SAVED_NOTICE });
    const failing = { save: vi.fn(async () => { throw new Error("disk full"); }), remove: vi.fn(async () => { throw new Error("disk full"); }) };
    await expect(persistLoginCredentials(failing, { email: "a@example.com", password: SECRET, rememberAccount: true, rememberPassword: true }))
      .resolves.toEqual({ notice: PASSWORD_NOT_SAVED_NOTICE });
    await expect(persistLoginCredentials(failing, { email: "a@example.com", password: SECRET, rememberAccount: true, rememberPassword: false }))
      .resolves.toEqual({ notice: "" });
    await expect(persistLoginCredentials(failing, { email: "a@example.com", password: SECRET, rememberAccount: false, rememberPassword: false }))
      .resolves.toEqual({ notice: "" });
    await expect(persistLoginCredentials(undefined, { email: "a@example.com", password: SECRET, rememberAccount: true, rememberPassword: true }))
      .resolves.toEqual({ notice: "" });
  });
});
