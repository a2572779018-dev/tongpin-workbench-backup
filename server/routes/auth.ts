import { randomInt, randomUUID } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { AppConfig } from "../config";
import { ApiError } from "../errors";
import { getMailMode, Mailer, type MailDelivery } from "../mailer";
import {
  generateCode,
  hashOpaque,
  issueAccessToken,
  issueRefreshSession,
  normalizeEmail,
  removeExpiredSecurityRecords,
} from "../security";
import { JsonStore } from "../store";
import { toPublicUser, type VerificationPurpose } from "../types";

const emailSchema = z.string().trim().email("邮箱格式不正确").max(200);
const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(100)
  .regex(/[A-Za-z]/, "密码必须包含字母")
  .regex(/\d/, "密码必须包含数字");

const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(30),
  password: passwordSchema,
});

const verifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(100),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(500),
});

const resetPasswordSchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/),
  password: passwordSchema,
});

const MAX_AVATAR_BYTES = 512 * 1024;
const avatarSchema = z.object({
  dataUrl: z.string().max(700_000).nullable(),
});

function normalizeAvatarDataUrl(dataUrl: string): string {
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) {
    throw new ApiError(
      400,
      "AVATAR_FORMAT_INVALID",
      "头像只支持 PNG、JPG 或 WebP 图片",
    );
  }
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    throw new ApiError(
      413,
      "AVATAR_TOO_LARGE",
      "头像处理后不能超过 512KB",
    );
  }
  const validSignature =
    (mime === "image/png" &&
      bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) ||
    (mime === "image/jpeg" &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (mime === "image/webp" &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP");
  if (!validSignature) {
    throw new ApiError(
      400,
      "AVATAR_CONTENT_INVALID",
      "图片内容与文件格式不一致",
    );
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const DUMMY_PASSWORD_HASH =
  "$2b$10$3euPcmQFCiblsZeEu5s7p.9QfM3r2oHTQxGZwnc7X1wfrN4d4De9e";

function debugCode(config: AppConfig, code: string): string | undefined {
  return getMailMode(config) === "preview" ? code : undefined;
}

export function createAuthRouter(
  store: JsonStore,
  config: AppConfig,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
): Router {
  const router = Router();
  const mailer = new Mailer(config);

  async function createVerification(
    email: string,
    userId: string | null,
    purpose: VerificationPurpose,
  ): Promise<{ code: string; delivery: MailDelivery }> {
    const code = generateCode();
    const now = new Date();
    const verificationId = randomUUID();
    await store.mutate((database) => {
      removeExpiredSecurityRecords(database);
      const latest = database.verificationCodes
        .filter(
          (candidate) =>
            candidate.email === email &&
            candidate.purpose === purpose &&
            !candidate.consumedAt,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (
        latest &&
        now.getTime() - Date.parse(latest.createdAt) < 60 * 1000
      ) {
        throw new ApiError(
          429,
          "CODE_COOLDOWN",
          "验证码发送过于频繁，请 60 秒后再试",
        );
      }
      for (const existing of database.verificationCodes) {
        if (
          existing.email === email &&
          existing.purpose === purpose &&
          !existing.consumedAt
        ) {
          existing.consumedAt = now.toISOString();
        }
      }
      database.verificationCodes.push({
        id: verificationId,
        userId,
        email,
        purpose,
        codeHash: hashOpaque(code),
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        attempts: 0,
        consumedAt: null,
        createdAt: now.toISOString(),
      });
    });
    try {
      const delivery = await mailer.sendCode(
        email,
        purpose,
        code,
        `verification-${purpose}-${verificationId}`,
      );
      return { code, delivery };
    } catch (error) {
      await store.mutate((database) => {
        const failed = database.verificationCodes.find(
          (candidate) => candidate.id === verificationId,
        );
        if (failed && !failed.consumedAt) {
          failed.consumedAt = new Date().toISOString();
        }
      });
      throw error;
    }
  }

  router.post("/register", async (request, response, next) => {
    try {
      const body = registerSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const passwordHash = await bcrypt.hash(body.password, 10);
      const now = new Date().toISOString();
      const user = await store.mutate((database) => {
        const existing = database.users.find(
          (candidate) => candidate.email === email,
        );
        if (existing && existing.status !== "pending_email") {
          throw new ApiError(409, "EMAIL_EXISTS", "该邮箱已经注册");
        }
        if (existing) {
          existing.name = body.name;
          existing.passwordHash = passwordHash;
          existing.updatedAt = now;
          return existing;
        }
        const created = {
          id: randomUUID(),
          email,
          name: body.name,
          passwordHash,
          role: "member" as const,
          status: "pending_email" as const,
          jobTitle: "",
          avatarSeed: randomInt(0, 6),
          avatarVersion: 0,
          avatarDataUrl: null,
          emailVerifiedAt: null,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        };
        database.users.push(created);
        return created;
      });
      const verification = await createVerification(
        email,
        user.id,
        "register",
      );
      response.status(201).json({
        nextStep: "verify_email",
        email,
        delivery: verification.delivery.provider,
        debugCode: debugCode(config, verification.code),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verify-email", async (request, response, next) => {
    try {
      const body = verifySchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const verificationResult = await store.mutate((database) => {
        const target = database.users.find(
          (candidate) => candidate.email === email,
        );
        if (!target) {
          throw new ApiError(404, "ACCOUNT_NOT_FOUND", "没有找到该注册账号");
        }
        if (target.emailVerifiedAt) {
          return { user: target };
        }
        const verification = database.verificationCodes
          .filter(
            (candidate) =>
              candidate.email === email &&
              candidate.purpose === "register" &&
              !candidate.consumedAt,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (
          !verification ||
          Date.parse(verification.expiresAt) <= Date.now()
        ) {
          throw new ApiError(400, "CODE_EXPIRED", "验证码已过期，请重新发送");
        }
        if (verification.attempts >= 5) {
          return {
            error: new ApiError(
              429,
              "CODE_LOCKED",
              "验证码错误次数过多，请重新发送",
            ),
          };
        }
        if (verification.codeHash !== hashOpaque(body.code)) {
          verification.attempts += 1;
          return {
            error: new ApiError(400, "CODE_INVALID", "验证码不正确"),
          };
        }
        const now = new Date().toISOString();
        verification.consumedAt = now;
        target.emailVerifiedAt = now;
        target.status = "pending_approval";
        target.updatedAt = now;
        return { user: target };
      });
      if ("error" in verificationResult) throw verificationResult.error;
      const user = verificationResult.user;
      response.json({
        nextStep: "await_approval",
        user: toPublicUser(user),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/resend-code", async (request, response, next) => {
    try {
      const body = z
        .object({
          email: emailSchema,
          purpose: z.enum(["register", "reset_password"]),
        })
        .parse(request.body);
      const email = normalizeEmail(body.email);
      const user = await store.read((database) =>
        database.users.find((candidate) => candidate.email === email),
      );
      if (!user) {
        response.json({ sent: true });
        return;
      }
      if (body.purpose === "register" && user.emailVerifiedAt) {
        throw new ApiError(409, "ALREADY_VERIFIED", "该邮箱已经完成验证");
      }
      const verification = await createVerification(
        email,
        user.id,
        body.purpose,
      );
      response.json({
        sent: true,
        delivery: verification.delivery.provider,
        debugCode: debugCode(config, verification.code),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", async (request, response, next) => {
    try {
      const body = loginSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const user = await store.read((database) =>
        database.users.find((candidate) => candidate.email === email),
      );
      const passwordMatches = await bcrypt.compare(
        body.password,
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
      if (!user || !passwordMatches) {
        throw new ApiError(401, "LOGIN_FAILED", "邮箱或密码不正确");
      }
      if (user.status === "pending_email") {
        throw new ApiError(403, "EMAIL_NOT_VERIFIED", "请先完成邮箱验证");
      }
      if (user.status === "pending_approval") {
        throw new ApiError(
          403,
          "ACCOUNT_PENDING",
          "账号正在等待管理员批准",
        );
      }
      if (user.status === "disabled") {
        throw new ApiError(403, "ACCOUNT_DISABLED", "账号已被管理员停用");
      }

      const session = await store.mutate((database) => {
        removeExpiredSecurityRecords(database);
        const current = database.users.find(
          (candidate) => candidate.id === user.id,
        );
        if (!current) {
          throw new ApiError(401, "LOGIN_FAILED", "邮箱或密码不正确");
        }
        current.lastLoginAt = new Date().toISOString();
        current.updatedAt = current.lastLoginAt;
        return {
          refreshToken: issueRefreshSession(
            database,
            current,
            request.header("user-agent") ?? "",
          ),
          user: current,
        };
      });
      response.json({
        accessToken: issueAccessToken(session.user, config),
        refreshToken: session.refreshToken,
        user: toPublicUser(session.user),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/refresh", async (request, response, next) => {
    try {
      const { refreshToken } = refreshSchema.parse(request.body);
      const rotated = await store.mutate((database) => {
        removeExpiredSecurityRecords(database);
        const sessionIndex = database.refreshSessions.findIndex(
          (session) => session.tokenHash === hashOpaque(refreshToken),
        );
        if (sessionIndex < 0) {
          throw new ApiError(401, "REFRESH_INVALID", "登录已过期，请重新登录");
        }
        const session = database.refreshSessions[sessionIndex];
        const user = database.users.find(
          (candidate) => candidate.id === session.userId,
        );
        if (!user || user.status !== "active") {
          database.refreshSessions.splice(sessionIndex, 1);
          throw new ApiError(401, "REFRESH_INVALID", "登录已过期，请重新登录");
        }
        database.refreshSessions.splice(sessionIndex, 1);
        return {
          user,
          refreshToken: issueRefreshSession(
            database,
            user,
            request.header("user-agent") ?? "",
          ),
        };
      });
      response.json({
        accessToken: issueAccessToken(rotated.user, config),
        refreshToken: rotated.refreshToken,
        user: toPublicUser(rotated.user),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (request, response, next) => {
    try {
      const body = refreshSchema.parse(request.body);
      await store.mutate((database) => {
        database.refreshSessions = database.refreshSessions.filter(
          (session) => session.tokenHash !== hashOpaque(body.refreshToken),
        );
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/forgot-password", async (request, response, next) => {
    try {
      const { email: rawEmail } = z
        .object({ email: emailSchema })
        .parse(request.body);
      const email = normalizeEmail(rawEmail);
      const user = await store.read((database) =>
        database.users.find((candidate) => candidate.email === email),
      );
      let verification:
        | { code: string; delivery: MailDelivery }
        | undefined;
      if (user?.emailVerifiedAt) {
        verification = await createVerification(
          email,
          user.id,
          "reset_password",
        );
      }
      response.json({
        sent: true,
        delivery: verification?.delivery.provider,
        debugCode: verification
          ? debugCode(config, verification.code)
          : undefined,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/reset-password", async (request, response, next) => {
    try {
      const body = resetPasswordSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const passwordHash = await bcrypt.hash(body.password, 10);
      const verificationError = await store.mutate((database) => {
        const user = database.users.find(
          (candidate) => candidate.email === email,
        );
        const verification = database.verificationCodes
          .filter(
            (candidate) =>
              candidate.email === email &&
              candidate.purpose === "reset_password" &&
              !candidate.consumedAt,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (
          !user ||
          !verification ||
          Date.parse(verification.expiresAt) <= Date.now()
        ) {
          throw new ApiError(400, "CODE_EXPIRED", "验证码已过期，请重新发送");
        }
        if (verification.attempts >= 5) {
          return new ApiError(
            429,
            "CODE_LOCKED",
            "验证码错误次数过多，请重新发送",
          );
        }
        if (verification.codeHash !== hashOpaque(body.code)) {
          verification.attempts += 1;
          return new ApiError(400, "CODE_INVALID", "验证码不正确");
        }
        const now = new Date().toISOString();
        verification.consumedAt = now;
        user.passwordHash = passwordHash;
        user.updatedAt = now;
        database.refreshSessions = database.refreshSessions.filter(
          (session) => session.userId !== user.id,
        );
        return null;
      });
      if (verificationError) throw verificationError;
      response.json({ reset: true });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/me/avatar", requireAuth, async (request, response, next) => {
    try {
      const { dataUrl } = avatarSchema.parse(request.body);
      if (request.currentUser!.role === "boss") {
        throw new ApiError(
          403,
          "BOSS_AVATAR_LOCKED",
          "不好意思，您无权限更换自己的头像",
        );
      }
      if (request.currentUser!.role !== "member") {
        throw new ApiError(
          403,
          "AVATAR_CHANGE_FORBIDDEN",
          "该账号的头像由系统统一管理",
        );
      }
      const normalized = dataUrl ? normalizeAvatarDataUrl(dataUrl) : null;
      const user = await store.mutate((database) => {
        const target = database.users.find(
          (candidate) => candidate.id === request.currentUser!.id,
        );
        if (!target || target.status !== "active") {
          throw new ApiError(
            401,
            "SESSION_INVALID",
            "登录状态已失效，请重新登录",
          );
        }
        if (target.role === "boss") {
          throw new ApiError(
            403,
            "BOSS_AVATAR_LOCKED",
            "不好意思，您无权限更换自己的头像",
          );
        }
        if (target.role !== "member") {
          throw new ApiError(
            403,
            "AVATAR_CHANGE_FORBIDDEN",
            "该账号的头像由系统统一管理",
          );
        }
        target.avatarDataUrl = normalized;
        target.avatarVersion += 1;
        target.updatedAt = new Date().toISOString();
        return target;
      });
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth, (request, response) => {
    response.json({ user: request.currentUser });
  });

  return router;
}
