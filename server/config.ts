import path from "node:path";
import "dotenv/config";
import {
  LORA_DEFAULT_RPC_URL,
  LORA_EXPLORER_API,
} from "./lora-chain/constants";

const DEVELOPMENT_JWT_SECRET =
  "tongpin-development-secret-change-before-production";

export interface AppConfig {
  host: string;
  port: number;
  dataFile: string;
  jwtSecret: string;
  clientOrigins: string[];
  bootstrapAdminEmail: string;
  bootstrapAdminPassword: string;
  bootstrapAdminName: string;
  devEmailPreview: boolean;
  isProduction: boolean;
  loraExplorerApi: string;
  loraRpcUrl: string;
  resend: {
    apiKey: string;
    from: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
}

function asBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export function loadConfig(
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const jwtSecret =
    process.env.JWT_SECRET ?? DEVELOPMENT_JWT_SECRET;

  const config: AppConfig = {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4318),
    dataFile: path.resolve(
      process.env.DATA_FILE ?? ".data/tongpin.json",
    ),
    jwtSecret,
    clientOrigins: (
      process.env.CLIENT_ORIGINS ??
      "http://127.0.0.1:5173,http://127.0.0.1:4173"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    bootstrapAdminEmail:
      process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@company.local",
    bootstrapAdminPassword:
      process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "Admin123!",
    bootstrapAdminName:
      process.env.BOOTSTRAP_ADMIN_NAME ?? "系统管理员",
    devEmailPreview: asBoolean(
      process.env.DEV_EMAIL_PREVIEW,
      false,
    ),
    isProduction,
    loraExplorerApi:
      process.env.LORA_EXPLORER_API_URL ?? LORA_EXPLORER_API,
    loraRpcUrl: process.env.LORA_RPC_URL ?? LORA_DEFAULT_RPC_URL,
    resend: {
      apiKey: process.env.RESEND_API_KEY ?? "",
      from: process.env.RESEND_FROM ?? "",
    },
    smtp: {
      host: process.env.SMTP_HOST ?? "",
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: asBoolean(process.env.SMTP_SECURE),
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
      from:
        process.env.SMTP_FROM ??
        "同频 <no-reply@company.local>",
    },
  };

  const finalConfig: AppConfig = {
    ...config,
    ...overrides,
    resend: {
      ...config.resend,
      ...(overrides.resend ?? {}),
    },
    smtp: {
      ...config.smtp,
      ...(overrides.smtp ?? {}),
    },
  };

  if (finalConfig.resend.apiKey && !finalConfig.resend.from) {
    throw new Error("配置 RESEND_API_KEY 时必须同时配置 RESEND_FROM");
  }
  if (
    finalConfig.isProduction &&
    (finalConfig.jwtSecret.length < 32 ||
      finalConfig.jwtSecret === DEVELOPMENT_JWT_SECRET)
  ) {
    throw new Error("生产环境必须配置至少 32 个字符的随机 JWT_SECRET");
  }
  if (
    finalConfig.isProduction &&
    finalConfig.bootstrapAdminPassword === "Admin123!"
  ) {
    throw new Error("生产环境必须更换 BOOTSTRAP_ADMIN_PASSWORD");
  }
  if (
    finalConfig.isProduction &&
    !finalConfig.resend.apiKey &&
    !finalConfig.smtp.host
  ) {
    throw new Error("生产环境必须配置 Resend 或 SMTP 邮件服务");
  }

  return finalConfig;
}
