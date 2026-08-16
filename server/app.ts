import { randomInt } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { AppConfig } from "./config";
import { errorHandler, notFoundHandler } from "./errors";
import { getMailMode } from "./mailer";
import {
  LoraChainCollector,
  type LoraChainDataSource,
} from "./lora-chain/collector";
import { ExplorerLoraChainDataSource } from "./lora-chain/source";
import { createRequireAuth } from "./middleware";
import { attachRealtime } from "./realtime";
import { createAdminRouter } from "./routes/admin";
import { createAvatarsRouter } from "./routes/avatars";
import { createAuthRouter } from "./routes/auth";
import { createBossRouter, silentRealtimeHub } from "./routes/boss";
import { createContactsRouter } from "./routes/contacts";
import { createNotificationsRouter } from "./routes/notifications";
import { createLoraChainRouter } from "./routes/lora-chain";
import { createTasksRouter } from "./routes/tasks";
import { createWorkReportsRouter } from "./routes/work-reports";
import { JsonStore } from "./store";

export interface AppRuntime {
  app: express.Express;
  server: HttpServer;
  store: JsonStore;
  loraCollector: LoraChainCollector;
}

export async function ensureBootstrapAdmin(
  store: JsonStore,
  config: AppConfig,
): Promise<void> {
  const email = config.bootstrapAdminEmail.trim().toLowerCase();
  const exists = await store.read((database) =>
    database.users.some((user) => user.email === email),
  );
  if (exists) return;

  const passwordHash = await bcrypt.hash(config.bootstrapAdminPassword, 10);
  const now = new Date().toISOString();
  await store.mutate((database) => {
    database.users.push({
      id: crypto.randomUUID(),
      email,
      name: config.bootstrapAdminName,
      passwordHash,
      role: "admin",
      status: "active",
      jobTitle: "系统管理员",
      avatarSeed: randomInt(0, 6),
      avatarVersion: 0,
      avatarDataUrl: null,
      emailVerifiedAt: now,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function createRuntime(
  config: AppConfig,
  options: {
    attachSockets?: boolean;
    loraSource?: LoraChainDataSource;
    startLoraCollector?: boolean;
  } = {},
): Promise<AppRuntime> {
  const store = await JsonStore.open(config.dataFile);
  await ensureBootstrapAdmin(store, config);

  const app = express();
  const server = createServer(app);
  const realtime =
    options.attachSockets === false
      ? silentRealtimeHub
      : attachRealtime(server, store, config);
  const requireAuth = createRequireAuth(store, config);
  const loraCollector = new LoraChainCollector(
    store,
    options.loraSource ?? ExplorerLoraChainDataSource.fromConfig(config),
    realtime,
  );

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (
          !origin ||
          origin === "null" ||
          config.clientOrigins.includes(origin)
        ) {
          callback(null, true);
          return;
        }
        callback(new Error("origin not allowed"));
      },
    }),
  );
  app.use(express.json({ limit: "768kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "tongpin-api",
      mailMode: getMailMode(config),
      time: new Date().toISOString(),
    });
  });
  app.use("/api/avatars", createAvatarsRouter(store));

  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.isProduction ? 40 : 500,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.use(
    "/api/auth",
    authLimiter,
    createAuthRouter(store, config, requireAuth),
  );
  app.use("/api/tasks", createTasksRouter(store, requireAuth, realtime));
  app.use("/api/admin", createAdminRouter(store, requireAuth));
  app.use(
    "/api/boss/lora-chain",
    createLoraChainRouter(store, requireAuth, loraCollector),
  );
  app.use(
    "/api/boss/work-reports",
    createWorkReportsRouter(store, requireAuth, realtime),
  );
  app.use("/api/boss", createBossRouter(store, requireAuth, realtime));
  app.use(
    "/api/contacts",
    createContactsRouter(store, requireAuth, realtime),
  );
  app.use(
    "/api/notifications",
    createNotificationsRouter(store, requireAuth, realtime),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (options.startLoraCollector) loraCollector.start();

  return { app, server, store, loraCollector };
}
