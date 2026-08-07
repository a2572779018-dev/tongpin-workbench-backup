import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiRequestError, publicRequest } from "../lib/api";

type AuthMode =
  | "login"
  | "register"
  | "verify"
  | "pending"
  | "forgot"
  | "reset";

type CodeDeliveryResponse = {
  delivery?: "resend" | "smtp" | "preview";
  debugCode?: string;
};

type EmailVerificationResponse = {
  nextStep: "await_approval" | "ready_to_login";
};

type RememberedAccount = {
  email: string;
  hasPassword: boolean;
  lastUsedAt: string;
};

export function AuthPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [debugCode, setDebugCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [rememberedAccounts, setRememberedAccounts] = useState<
    RememberedAccount[]
  >([]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountBusyEmail, setAccountBusyEmail] = useState("");
  const accountFieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    if (!window.tongpin?.credentials) return;
    void window.tongpin.credentials
      .list()
      .then((accounts) => {
        if (!disposed) setRememberedAccounts(accounts);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        accountFieldRef.current &&
        !accountFieldRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  function moveTo(next: AuthMode) {
    setMode(next);
    setAccountMenuOpen(false);
    setError("");
    setNotice("");
    if (next !== "verify" && next !== "reset") {
      setCode("");
      setDebugCode("");
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    try {
      if (mode === "login") {
        await login(email, password, rememberPassword);
        return;
      }
      if (mode === "register") {
        const result = await publicRequest<CodeDeliveryResponse>(
          "/api/auth/register",
          {
            method: "POST",
            body: JSON.stringify({ email, name, password }),
          },
        );
        setDebugCode(result.debugCode ?? "");
        setMode("verify");
        setNotice(
          result.delivery === "preview"
            ? "本地测试验证码已生成。"
            : "验证码已发送，请检查收件箱和垃圾邮件。",
        );
        return;
      }
      if (mode === "verify") {
        const result = await publicRequest<EmailVerificationResponse>(
          "/api/auth/verify-email",
          {
            method: "POST",
            body: JSON.stringify({ email, code }),
          },
        );
        if (result.nextStep === "ready_to_login") {
          setMode("login");
          setCode("");
          setNotice("邮箱验证完成，请登录。");
        } else {
          setMode("pending");
        }
        return;
      }
      if (mode === "forgot") {
        const result = await publicRequest<CodeDeliveryResponse>(
          "/api/auth/forgot-password",
          {
            method: "POST",
            body: JSON.stringify({ email }),
          },
        );
        setDebugCode(result.debugCode ?? "");
        setCode("");
        setMode("reset");
        setNotice(
          result.delivery === "preview"
            ? "本地测试验证码已生成。"
            : "若该邮箱已注册，验证码已发送，请检查收件箱和垃圾邮件。",
        );
        return;
      }
      if (mode === "reset") {
        await publicRequest("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ email, code, password }),
        });
        if (window.tongpin?.credentials) {
          try {
            await window.tongpin.credentials.save({
              email,
              password,
              rememberPassword: true,
            });
          } catch {
            // 重置成功优先，不将密码降级保存到网页缓存。
          }
        }
        setRememberPassword(true);
        setPassword("");
        setCode("");
        setMode("login");
        setNotice("密码已更新，请使用新密码登录。");
      }
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.code === "ACCOUNT_PENDING") {
          setMode("pending");
          return;
        }
        if (caught.code === "EMAIL_NOT_VERIFIED") {
          setMode("verify");
          setError("邮箱还未验证，请重新获取验证码。");
          return;
        }
        setError(caught.message);
      } else {
        setError("无法连接服务器，请确认 API 已启动。");
      }
    } finally {
      setLoading(false);
    }
  }

  async function resendCode(purpose: "register" | "reset_password") {
    setLoading(true);
    setError("");
    try {
      const result = await publicRequest<CodeDeliveryResponse>(
        "/api/auth/resend-code",
        {
          method: "POST",
          body: JSON.stringify({ email, purpose }),
        },
      );
      setDebugCode(result.debugCode ?? "");
      setNotice(
        result.delivery === "preview"
          ? "新的本地测试验证码已生成。"
          : "新的验证码已发送，请检查收件箱和垃圾邮件。",
      );
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : "验证码发送失败，请稍后重试。",
      );
    } finally {
      setLoading(false);
    }
  }

  async function selectRememberedAccount(account: RememberedAccount) {
    if (!window.tongpin?.credentials) return;
    setAccountBusyEmail(account.email);
    setError("");
    try {
      const saved = await window.tongpin.credentials.load(account.email);
      if (!saved) {
        setRememberedAccounts((current) =>
          current.filter((item) => item.email !== account.email),
        );
        return;
      }
      setEmail(saved.email);
      setPassword(saved.password ?? "");
      setRememberPassword(saved.rememberPassword);
      setShowPassword(false);
      setAccountMenuOpen(false);
    } catch {
      setError("无法读取该账号的安全密码，请手动输入。");
    } finally {
      setAccountBusyEmail("");
    }
  }

  async function removeRememberedAccount(accountEmail: string) {
    if (!window.tongpin?.credentials) return;
    setAccountBusyEmail(accountEmail);
    setError("");
    try {
      await window.tongpin.credentials.remove(accountEmail);
      setRememberedAccounts((current) =>
        current.filter((item) => item.email !== accountEmail),
      );
      if (email.trim().toLowerCase() === accountEmail) {
        setPassword("");
        setRememberPassword(true);
      }
    } catch {
      setError("删除登录记录失败，请重试。");
    } finally {
      setAccountBusyEmail("");
    }
  }

  const isCodeStep = mode === "verify" || mode === "reset";
  const title = {
    login: "欢迎回来",
    register: "创建工作账号",
    verify: "验证你的邮箱",
    pending: "等待管理员批准",
    forgot: "找回密码",
    reset: "设置新密码",
  }[mode];
  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup brand-lockup--light">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span>
            <b>同频</b>
            <small>TONGPIN</small>
          </span>
        </div>

        <div className="auth-story__copy">
          <h1>
            让每个人的
            <br />
            今日工作<span>清晰发生。</span>
          </h1>
        </div>

        <div className="day-ticket" aria-label="工作日进度示例">
          <div className="day-ticket__date">
            <small>JUL / 2026</small>
            <strong>28</strong>
            <span>星期二</span>
          </div>
          <div className="day-ticket__tasks">
            <div>
              <span className="task-dot task-dot--done">
                <Check size={12} />
              </span>
              晨会同步产品进度
            </div>
            <div>
              <span className="task-dot task-dot--doing" />
              完成客户方案评审
            </div>
            <div>
              <span className="task-dot" />
              整理明日优先事项
            </div>
          </div>
          <span className="day-ticket__progress">1 / 3 完成</span>
        </div>

      </section>

      <section className="auth-panel">
        <div className="auth-card">
          {mode !== "login" && (
            <button
              className="back-button"
              type="button"
              onClick={() => moveTo("login")}
            >
              <ArrowLeft size={16} />
              返回登录
            </button>
          )}

          {mode === "pending" ? (
            <div className="pending-state">
              <div className="pending-state__icon">
                <ShieldCheck size={30} />
              </div>
              <h2>{title}</h2>
              <div className="pending-steps">
                <div className="is-done">
                  <span>
                    <Check size={14} />
                  </span>
                  邮箱验证完成
                </div>
                <div className="is-current">
                  <span>2</span>
                  管理员审核中
                </div>
                <div>
                  <span>3</span>
                  登录同频
                </div>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => moveTo("login")}
              >
                返回登录页
                <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <>
              <div className="auth-card__heading">
                <h2>{title}</h2>
                {isCodeStep && email && <p>{email}</p>}
              </div>

              <form onSubmit={handleSubmit}>
                {mode === "register" && (
                  <label className="field">
                    <span>你的姓名</span>
                    <span className="input-shell">
                      <UserRound size={17} />
                      <input
                        autoComplete="name"
                        placeholder="例如：林小满"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        required
                        minLength={2}
                      />
                    </span>
                  </label>
                )}

                {(mode === "login" ||
                  mode === "register" ||
                  mode === "forgot") && (
                  <div
                    className="field auth-account-field"
                    ref={accountFieldRef}
                  >
                    <span id="auth-email-label">邮箱</span>
                    <span className="input-shell">
                      <Mail size={17} />
                      <input
                        aria-labelledby="auth-email-label"
                        type="email"
                        autoComplete="email"
                        placeholder="name@example.com"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          setAccountMenuOpen(false);
                        }}
                        required
                      />
                      {mode === "login" && (
                        <button
                          className="account-picker-toggle"
                          type="button"
                          aria-label="选择登录过的账号"
                          aria-haspopup="listbox"
                          aria-expanded={accountMenuOpen}
                          onClick={() =>
                            setAccountMenuOpen((current) => !current)
                          }
                        >
                          <ChevronDown
                            size={18}
                            className={accountMenuOpen ? "is-open" : ""}
                          />
                        </button>
                      )}
                    </span>

                    {mode === "login" && accountMenuOpen && (
                      <div
                        className="account-picker"
                        role="listbox"
                        aria-label="登录过的账号"
                      >
                        {rememberedAccounts.length === 0 ? (
                          <div className="account-picker__empty">
                            暂无登录记录
                          </div>
                        ) : (
                          rememberedAccounts.map((account) => (
                            <div
                              className="account-picker__row"
                              key={account.email}
                            >
                              <button
                                className="account-picker__select"
                                type="button"
                                role="option"
                                aria-selected={
                                  email.trim().toLowerCase() === account.email
                                }
                                disabled={accountBusyEmail === account.email}
                                onClick={() =>
                                  void selectRememberedAccount(account)
                                }
                              >
                                <span
                                  className="account-picker__avatar"
                                  aria-hidden="true"
                                >
                                  {account.email.slice(0, 1).toUpperCase()}
                                </span>
                                <span>
                                  <b>{account.email}</b>
                                  <small>
                                    {account.hasPassword
                                      ? "已记住密码"
                                      : "仅记住账号"}
                                  </small>
                                </span>
                              </button>
                              <button
                                className="account-picker__remove"
                                type="button"
                                aria-label={`删除 ${account.email} 的登录记录`}
                                title="删除登录记录"
                                disabled={accountBusyEmail === account.email}
                                onClick={() =>
                                  void removeRememberedAccount(account.email)
                                }
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}

                {isCodeStep && (
                  <label className="field">
                    <span>6 位验证码</span>
                    <span className="input-shell input-shell--code">
                      <KeyRound size={17} />
                      <input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
                        value={code}
                        onChange={(event) =>
                          setCode(
                            event.target.value.replace(/\D/g, "").slice(0, 6),
                          )
                        }
                        required
                        pattern="\d{6}"
                      />
                    </span>
                  </label>
                )}

                {(mode === "login" ||
                  mode === "register" ||
                  mode === "reset") && (
                  <label className="field">
                    <span>{mode === "reset" ? "新密码" : "密码"}</span>
                    <span className="input-shell">
                      <LockKeyhole size={17} />
                      <input
                        type={showPassword ? "text" : "password"}
                        autoComplete={
                          mode === "login"
                            ? "current-password"
                            : "new-password"
                        }
                        placeholder={
                          mode === "login" ? "输入密码" : "至少 8 位，含字母和数字"
                        }
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                        minLength={mode === "login" ? 1 : 8}
                      />
                      <button
                        className="password-toggle"
                        type="button"
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        onClick={() => setShowPassword((value) => !value)}
                      >
                        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </span>
                  </label>
                )}

                {mode === "login" && (
                  <label className="remember-login">
                    <input
                      type="checkbox"
                      checked={rememberPassword}
                      onChange={(event) =>
                        setRememberPassword(event.target.checked)
                      }
                    />
                    <span aria-hidden="true">
                      {rememberPassword && <Check size={13} />}
                    </span>
                    <b>记住密码</b>
                  </label>
                )}

                {debugCode && (
                  <div className="dev-code" role="status">
                    <span>仅本地测试验证码</span>
                    <button type="button" onClick={() => setCode(debugCode)}>
                      {debugCode}
                    </button>
                  </div>
                )}

                {error && <div className="form-message is-error">{error}</div>}
                {notice && (
                  <div className="form-message is-success">{notice}</div>
                )}

                <button
                  className="primary-button"
                  type="submit"
                  disabled={loading}
                >
                  {loading
                    ? "正在处理…"
                    : {
                        login: "登录同频",
                        register: "注册并验证邮箱",
                        verify: "确认验证码",
                        forgot: "发送重置验证码",
                        reset: "更新密码",
                        pending: "",
                      }[mode]}
                  {!loading && <ArrowRight size={17} />}
                </button>

                {mode === "login" && (
                  <button
                    className="text-button auth-forgot"
                    type="button"
                    onClick={() => moveTo("forgot")}
                  >
                    忘记密码？
                  </button>
                )}
              </form>

              {isCodeStep && (
                <p className="resend-line">
                  没收到验证码？
                  <button
                    type="button"
                    onClick={() =>
                      void resendCode(
                        mode === "verify" ? "register" : "reset_password",
                      )
                    }
                    disabled={loading}
                  >
                    重新发送
                  </button>
                </p>
              )}

              {mode === "login" && (
                <div className="auth-switch">
                  还没有账号？
                  <button type="button" onClick={() => moveTo("register")}>
                    注册账号
                  </button>
                </div>
              )}

            </>
          )}
        </div>
      </section>
    </main>
  );
}
