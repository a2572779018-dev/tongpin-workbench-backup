import type { VerificationPurpose } from "../../server/types";
import { ApiError, isEnabled, type WorkerEnv } from "./platform";

const PURPOSE_TEXT: Record<VerificationPurpose, string> = {
  register: "验证邮箱",
  reset_password: "重置密码",
};

export type MailMode = "resend" | "preview" | "unconfigured";

export function getMailMode(env: WorkerEnv): MailMode {
  if (env.RESEND_API_KEY && env.RESEND_FROM) return "resend";
  if (isEnabled(env.DEV_EMAIL_PREVIEW)) return "preview";
  return "unconfigured";
}

function emailContent(
  purpose: VerificationPurpose,
  code: string,
): { subject: string; text: string; html: string } {
  const action = PURPOSE_TEXT[purpose];
  return {
    subject: `同频 · ${action}验证码`,
    text: [
      `你正在进行“${action}”。`,
      "",
      `验证码：${code}`,
      "",
      "验证码 10 分钟内有效，请勿转发给他人。",
      "若非本人操作，请忽略此邮件。",
    ].join("\n"),
    html: `
      <div style="margin:0;background:#f7f2e6;padding:32px 16px;font-family:Arial,'Microsoft YaHei',sans-serif;color:#171717">
        <div style="max-width:520px;margin:0 auto;background:#fffdf8;border:2px solid #171717;border-radius:20px;overflow:hidden;box-shadow:6px 6px 0 #171717">
          <div style="padding:18px 24px;background:#ffd84d;border-bottom:2px solid #171717;font-size:18px;font-weight:800">同频</div>
          <div style="padding:28px 24px 30px">
            <p style="margin:0 0 8px;color:#5f5b52">你正在进行</p>
            <h1 style="margin:0 0 24px;font-size:28px">${action}</h1>
            <div style="padding:18px 20px;background:#f0e9ff;border:2px dashed #171717;border-radius:14px;text-align:center;font-size:34px;font-weight:800;letter-spacing:10px">${code}</div>
            <p style="margin:22px 0 0;line-height:1.7;color:#5f5b52">验证码 10 分钟内有效，请勿转发给他人。若非本人操作，请忽略此邮件。</p>
          </div>
        </div>
      </div>
    `,
  };
}

export async function sendCodeEmail(
  env: WorkerEnv,
  email: string,
  purpose: VerificationPurpose,
  code: string,
  idempotencyKey: string,
): Promise<{ provider: "resend" | "preview"; messageId?: string }> {
  const mode = getMailMode(env);
  if (mode === "preview") {
    console.info(`[本地邮件预览] ${email} ${PURPOSE_TEXT[purpose]} ${code}`);
    return { provider: "preview" };
  }
  if (mode !== "resend") {
    throw new ApiError(
      503,
      "EMAIL_SERVICE_NOT_CONFIGURED",
      "邮件服务尚未配置，暂时无法发送验证码",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [email],
      ...emailContent(purpose, code),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
  };
  if (!response.ok || !payload.id) {
    console.error("Resend 邮件发送失败", {
      status: response.status,
      message: payload.message,
    });
    throw new ApiError(
      502,
      "EMAIL_DELIVERY_FAILED",
      "验证码邮件发送失败，请检查邮箱地址或稍后重试",
    );
  }
  return { provider: "resend", messageId: payload.id };
}
