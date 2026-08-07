import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse,
} from "resend";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { getMailMode, Mailer } from "./mailer";

function baseConfig() {
  return loadConfig({
    isProduction: false,
    devEmailPreview: false,
    resend: { apiKey: "", from: "" },
    smtp: {
      host: "",
      port: 587,
      secure: false,
      user: "",
      pass: "",
      from: "同频 <no-reply@example.com>",
    },
  });
}

describe("Mailer", () => {
  it("通过 Resend 发送真实验证码并携带幂等键", async () => {
    const send = vi.fn(
      async (
        _payload: CreateEmailOptions,
        _options?: CreateEmailRequestOptions,
      ): Promise<CreateEmailResponse> => ({
        data: { id: "email_123" },
        error: null,
        headers: null,
      }),
    );
    const config = loadConfig({
      ...baseConfig(),
      resend: {
        apiKey: "re_test_key",
        from: "同频 <verify@notify.example.com>",
      },
    });

    expect(getMailMode(config)).toBe("resend");
    const result = await new Mailer(config, send).sendCode(
      "member@example.com",
      "register",
      "458470",
      "verification-register-id-123",
    );

    expect(result).toEqual({
      provider: "resend",
      messageId: "email_123",
    });
    expect(send).toHaveBeenCalledOnce();
    const [payload, options] = send.mock.calls[0];
    expect(payload).toMatchObject({
      from: "同频 <verify@notify.example.com>",
      to: "member@example.com",
      subject: "同频 · 验证邮箱验证码",
    });
    expect(payload.text).toContain("458470");
    expect(payload.html).toContain("458470");
    expect(options).toEqual({
      idempotencyKey: "verification-register-id-123",
    });
  });

  it("把 Resend 投递失败转换为可读的 API 错误", async () => {
    const send = vi.fn(
      async (): Promise<CreateEmailResponse> => ({
        data: null,
        error: {
          name: "invalid_from_address",
          message: "from address is invalid",
          statusCode: 422,
        },
        headers: null,
      }),
    );
    const config = loadConfig({
      ...baseConfig(),
      resend: {
        apiKey: "re_test_key",
        from: "同频 <verify@notify.example.com>",
      },
    });

    await expect(
      new Mailer(config, send).sendCode(
        "member@example.com",
        "register",
        "458470",
        "verification-register-id-456",
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: "EMAIL_DELIVERY_FAILED",
    });
  });

  it("未配置邮件服务时拒绝伪装成发送成功", async () => {
    const config = baseConfig();

    expect(getMailMode(config)).toBe("unconfigured");
    await expect(
      new Mailer(config).sendCode(
        "member@example.com",
        "register",
        "458470",
        "verification-register-id-789",
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "EMAIL_SERVICE_NOT_CONFIGURED",
    });
  });

  it("生产环境没有真实邮件服务时拒绝启动", () => {
    expect(() =>
      loadConfig({
        ...baseConfig(),
        isProduction: true,
        jwtSecret: "production-random-secret-with-at-least-32-characters",
        bootstrapAdminPassword: "ProductionAdmin987!",
      }),
    ).toThrow("生产环境必须配置 Resend 或 SMTP 邮件服务");
  });
});
