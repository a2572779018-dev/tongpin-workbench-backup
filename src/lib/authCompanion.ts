export type AuthCompanionMode =
  | "login"
  | "register"
  | "verify"
  | "pending"
  | "forgot"
  | "reset";

export type AuthCompanionField =
  | "name"
  | "email"
  | "password"
  | "code"
  | null;

export type AuthCompanionAction = "idle" | "hover" | "pressed";

export type AuthCompanionMood =
  | "idle"
  | "watching"
  | "happy"
  | "private"
  | "excited"
  | "pressed"
  | "loading"
  | "error"
  | "success";

export type AuthCompanionView = {
  message: string;
  mood: AuthCompanionMood;
  privateMode: boolean;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidLoginEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim());
}

export function getAuthCompanionView({
  mode,
  activeField,
  email,
  loading,
  error,
  notice,
  action,
}: {
  mode: AuthCompanionMode;
  activeField: AuthCompanionField;
  email: string;
  loading: boolean;
  error: string;
  notice: string;
  action: AuthCompanionAction;
}): AuthCompanionView {
  const privateMode = activeField === "password";

  if (loading) {
    return {
      message: "正在为你连接工作台…",
      mood: "loading",
      privateMode,
    };
  }

  if (error) {
    return {
      message: "这次没有连上，请看下方提示。",
      mood: "error",
      privateMode,
    };
  }

  if (notice) {
    return {
      message: "好了，下一步继续。",
      mood: "success",
      privateMode,
    };
  }

  if (privateMode) {
    return {
      message: "放心输入，我已经转过去了。",
      mood: "private",
      privateMode: true,
    };
  }

  if (activeField === "email") {
    return isValidLoginEmail(email)
      ? {
          message: "邮箱格式没问题。",
          mood: "happy",
          privateMode: false,
        }
      : {
          message: "我在看邮箱这一栏，继续输入吧。",
          mood: "watching",
          privateMode: false,
        };
  }

  if (activeField === "name") {
    return {
      message: "你好，先告诉我怎么称呼你。",
      mood: "watching",
      privateMode: false,
    };
  }

  if (activeField === "code") {
    return {
      message: "验证码填好，我们就继续。",
      mood: "watching",
      privateMode: false,
    };
  }

  if (action === "pressed") {
    return {
      message: "收到，马上出发。",
      mood: "pressed",
      privateMode: false,
    };
  }

  if (action === "hover") {
    return {
      message: "准备好了，就登录同频。",
      mood: "excited",
      privateMode: false,
    };
  }

  const modeMessage: Record<AuthCompanionMode, string> = {
    login: "欢迎回来，今天也一起同频。",
    register: "欢迎加入，把每天的工作安排清楚。",
    verify: "验证邮箱后，就能进入同频。",
    pending: "资料已收到，等待管理员批准。",
    forgot: "别担心，我们一起找回密码。",
    reset: "设置新密码，马上回到工作台。",
  };

  return {
    message: modeMessage[mode],
    mood: "idle",
    privateMode: false,
  };
}
