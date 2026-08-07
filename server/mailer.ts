import nodemailer from "nodemailer";
import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from "resend";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import type { VerificationPurpose } from "./types";

const PURPOSE_TEXT: Record<VerificationPurpose, string> = {
  register: "验证邮箱",
  reset_password: "重置密码",
};

type ResendSend = (
  payload: CreateEmailOptions,
  options?: CreateEmailRequestOptions,
) => Promise<CreateEmailResponse>;

export type MailMode = "resend" | "smtp" | "preview" | "unconfigured";

export interface MailDelivery {
  provider: Exclude<MailMode, "unconfigured">;
  messageId?: string;
}

export function getMailMode(config: AppConfig): MailMode {
  if (config.resend.apiKey && config.resend.from) return "resend";
  if (config.smtp.host) return "smtp";
  if (config.devEmailPreview && !config.isProduction) return "preview";
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
          <div style="padding:18px 24px;background:#ffd84d;border-bottom:2px solid #171717;font-size:18px;font-weight:800">
            同频
          </div>
          <div style="padding:28px 24px 30px">
            <p style="margin:0 0 8px;color:#5f5b52">你正在进行</p>
            <h1 style="margin:0 0 24px;font-size:28px">${action}</h1>
            <div style="padding:18px 20px;background:#f0e9ff;border:2px dashed #171717;border-radius:14px;text-align:center;font-size:34px;font-weight:800;letter-spacing:10px">
              ${code}
            </div>
            <p style="margin:22px 0 0;line-height:1.7;color:#5f5b52">
              验证码 10 分钟内有效，请勿转发给他人。若非本人操作，请忽略此邮件。
            </p>
          </div>
        </div>
      </div>
    `,
  };
}

export class Mailer {
  private readonly resendSend: ResendSend | null;

  constructor(
    private readonly config: AppConfig,
    resendSend?: ResendSend,
  ) {
    if (resendSend) {
      this.resendSend = resendSend;
      return;
    }
    if (getMailMode(config) === "resend") {
      const resend = new Resend(config.resend.apiKey);
      this.resendSend = resend.emails.send.bind(resend.emails);
      return;
    }
    this.resendSend = null;
  }

  async sendCode(
    email: string,
    purpose: VerificationPurpose,
    code: string,
    idempotencyKey: string,
  ): Promise<MailDelivery> {
    const mode = getMailMode(this.config);
    const content = emailContent(purpose, code);

    if (mode === "resend" && this.resendSend) {
      try {
        const result = await this.resendSend(
          {
            from: this.config.resend.from,
            to: email,
            ...content,
          },
          { idempotencyKey },
        );
        if (result.error) {
          console.error("Resend 邮件发送失败", {
            name: result.error.name,
            statusCode: result.error.statusCode,
          });
          throw new ApiError(
            502,
            "EMAIL_DELIVERY_FAILED",
            "验证码邮件发送失败，请检查邮箱地址或稍后重试",
          );
        }
        return { provider: "resend", messageId: result.data.id };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        console.error("Resend 邮件请求失败", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
        throw new ApiError(
          502,
          "EMAIL_DELIVERY_FAILED",
          "邮件服务暂时不可用，请稍后重试",
        );
      }
    }

    if (mode === "smtp") {
      const transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth:
          this.config.smtp.user && this.config.smtp.pass
            ? {
                user: this.config.smtp.user,
                pass: this.config.smtp.pass,
              }
            : undefined,
      });
      try {
        const result = await transporter.sendMail({
          from: this.config.smtp.from,
          to: email,
          ...content,
        });
        return { provider: "smtp", messageId: result.messageId };
      } catch (error) {
        console.error("SMTP 邮件发送失败", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
        throw new ApiError(
          502,
          "EMAIL_DELIVERY_FAILED",
          "验证码邮件发送失败，请检查邮箱地址或稍后重试",
        );
      }
    }

    if (mode === "preview") {
      console.info(`[本地邮件预览] ${PURPOSE_TEXT[purpose]}验证码：${code}`);
      return { provider: "preview" };
    }

    throw new ApiError(
      503,
      "EMAIL_SERVICE_NOT_CONFIGURED",
      "邮件服务尚未配置，暂时无法发送验证码",
    );
  }
}
