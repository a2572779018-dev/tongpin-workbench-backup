/**
 * Sign-in "记住账号 / 记住密码" rules shared by AuthPage and AuthContext.
 * Passwords live only in the Electron main-process vault, encrypted with
 * safeStorage (macOS Keychain / Windows DPAPI). The renderer never writes
 * them to localStorage or logs, and receives one only after the user
 * explicitly picks a remembered account on the sign-in screen.
 */
type CredentialsBridge = NonNullable<Window["tongpin"]>["credentials"];
type RevealResult = Awaited<ReturnType<NonNullable<CredentialsBridge["reveal"]>>>;

export interface RememberedAccount {
  email: string;
  lastUsedAt: string;
  passwordRemembered?: boolean;
}

export const PASSWORD_NOT_SAVED_NOTICE =
  "系统安全存储暂不可用，本次未保存密码；下次登录请手动输入。";

export function rememberedAccountHint(account: RememberedAccount): string {
  return account.passwordRemembered ? "已记住密码" : "仅记住账号";
}

export function normalizeLoginEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** One short explanation when a remembered password cannot be used. */
export function revealFailureMessage(
  result: RevealResult | null,
  platform = "",
): string {
  if (result?.state === "unavailable" && result.reason === "unreadable") {
    return "保存的密码已无法读取（常见于应用更新后），已删除，账号仍保留。请重新输入，登录后会重新保存。";
  }
  if (platform === "darwin") {
    return "钥匙串暂未允许读取保存的密码，请手动输入。弹出钥匙串提示时请选“始终允许”，必要时完整退出后重新打开同频。";
  }
  return "系统安全存储暂不可用，暂时无法读取保存的密码，请手动输入。";
}

export interface RememberedPasswordResolution {
  password: string;
  rememberPassword: boolean;
  message: string;
  /** The stored flag changed (secret dropped or missing): reload the list. */
  refresh: boolean;
}

/** Autofill for an explicit remembered-account selection. Never throws. */
export async function resolveRememberedPassword(
  credentials: Pick<CredentialsBridge, "reveal"> | undefined,
  account: RememberedAccount,
  platform = "",
): Promise<RememberedPasswordResolution> {
  if (!account.passwordRemembered || !credentials?.reveal) {
    return { password: "", rememberPassword: false, message: "", refresh: false };
  }
  let result: RevealResult | null = null;
  try {
    result = await credentials.reveal(account.email);
  } catch {
    result = null;
  }
  if (result?.state === "ready") {
    return { password: result.password, rememberPassword: true, message: "", refresh: false };
  }
  if (result?.state === "missing") {
    return { password: "", rememberPassword: false, message: "", refresh: true };
  }
  if (result?.state === "unavailable" && result.reason === "session-active") {
    return { password: "", rememberPassword: true, message: "", refresh: false };
  }
  // Keep the opt-in so the password is saved again after this login.
  return {
    password: "",
    rememberPassword: true,
    message: revealFailureMessage(result, platform),
    refresh: result?.state === "unavailable" && result.reason === "unreadable",
  };
}

/**
 * After the server accepted the login: remember or forget the account and,
 * only with explicit opt-in, the password. Failures never block sign-in; the
 * returned notice explains a password that could not be stored.
 */
export async function persistLoginCredentials(
  credentials: Pick<CredentialsBridge, "save" | "remove"> | undefined,
  {
    email,
    password,
    rememberAccount,
    rememberPassword,
  }: { email: string; password: string; rememberAccount: boolean; rememberPassword: boolean },
): Promise<{ notice: string }> {
  if (!credentials) return { notice: "" };
  const wantsPassword = rememberAccount && rememberPassword;
  try {
    if (!rememberAccount) {
      await credentials.remove(email);
      return { notice: "" };
    }
    const result = await credentials.save(
      wantsPassword
        ? { email, password, rememberPassword: true }
        : { email, rememberPassword: false },
    );
    const stored = typeof result === "object" && result !== null && result.password === "stored";
    return { notice: wantsPassword && !stored ? PASSWORD_NOT_SAVED_NOTICE : "" };
  } catch {
    return { notice: wantsPassword ? PASSWORD_NOT_SAVED_NOTICE : "" };
  }
}
