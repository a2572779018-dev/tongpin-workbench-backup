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
import { createNodeAi } from "./ai/node";
import type { AiTransport } from "./ai/provider";
import type { AiStore } from "./ai/storage";
import { createAiRouter } from "./routes/ai";
import { AiWorkspaceRepository } from "./ai/workspace";
import { createAiWorkspaceRouter } from "./ai/workspaceRoutes";
import { AiPersonaRepository } from "./ai/persona";
import { createAiPersonaRouter } from "./ai/personaRoutes";
import { createAiAgentScheduler, type AiAgentScheduler } from "./ai/backgroundAgent";
import { aiTenantIdFromPrincipal } from "./ai/tenant";
import { createDifyToolResponse, type DifyRouteOptions } from "./ai/difyRuntimeRoutes";
import type { DifyRuntimeConfig } from "./ai/difyRuntime";

export interface AppRuntime {
  app: express.Express;
  server: HttpServer;
  store: JsonStore;
  loraCollector: LoraChainCollector;
  aiAgentScheduler: AiAgentScheduler;
  aiStore: AiStore;
  closeAi: () => void;
  /** Stop background work and HTTP requests before releasing the AI database. Safe before listen and on repeated calls. */
  close: () => Promise<void>;
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
    startAiAgentScheduler?: boolean;
    aiTransport?: AiTransport;
    difyConfig?: DifyRuntimeConfig;
    difyServiceSecret?: string;
  } = {},
): Promise<AppRuntime> {
  const store = await JsonStore.open(config.dataFile);
  await ensureBootstrapAdmin(store, config);
  const ai = await createNodeAi(config.dataFile, options.aiTransport, (tenantId, userId) => store.read(database => database.users.some(user =>
    user.id === userId && user.status === "active" && (user.role === "member" || user.role === "boss") && aiTenantIdFromPrincipal(user) === tenantId,
  )));
  const aiWorkspace = new AiWorkspaceRepository(ai.store.sql);
  aiWorkspace.initialize();
  const aiPersona = new AiPersonaRepository(ai.store.sql);
  aiPersona.initialize();
  const dify: DifyRouteOptions = {
    config: options.difyConfig ?? { enabled: process.env.DIFY_TOOL_ENABLED === "true", appId: process.env.DIFY_APP_ID ?? "" },
    serviceSecret: options.difyServiceSecret ?? process.env.DIFY_TOOL_SECRET ?? "",
    principalActive: (tenantId, userId) => store.read(database => database.users.some(user =>
      user.id === userId && user.status === "active" && (user.role === "member" || user.role === "boss") && aiTenantIdFromPrincipal(user) === tenantId,
    )),
  };

  const app = express();
  const server = createServer(app);
  const aiAgentScheduler = createAiAgentScheduler(ai.service);
  server.once("close", () => { void aiAgentScheduler.stop().finally(ai.close); });
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
  // Workspace snapshots have a separate authenticated, chunk-backed limit; do not grow every API body limit.
  app.use("/api/ai/workspace", createAiWorkspaceRouter(aiWorkspace, requireAuth));
  app.use("/api/ai/persona", createAiPersonaRouter(aiPersona, requireAuth));
  app.use("/api/ai/chat", express.json({ limit: 1600 * 1024 }));
  app.use("/api/ai/preflight", express.json({ limit: 1600 * 1024 }));
  app.post("/api/dify/tools/invoke", express.raw({ type: "application/json", limit: "16kb" }), async (request, response) => {
    const result = await createDifyToolResponse(ai.service, new Request("http://localhost/api/dify/tools/invoke", {
      method: "POST",
      headers: { Authorization: request.get("Authorization") ?? "", "X-Dify-Tool-Secret": request.get("X-Dify-Tool-Secret") ?? "" },
      ...(Buffer.isBuffer(request.body) ? { body: request.body.toString("utf8") } : {}),
    }), dify);
    result.headers.forEach((value, key) => response.set(key, value));
    response.status(result.status).send(await result.text());
  });
  app.use("/api/dify/tools/invoke", (error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if ((error as { type?: string })?.type !== "entity.too.large") { next(error); return; }
    response.set("Cache-Control", "no-store").status(413).json({ error: { code: "DIFY_TOOL_INPUT_INVALID", message: "Dify 请求内容过大" } });
  });
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
  app.get("/api/video-reference/:id", async (request, response) => {
    const image = await ai.service.video.referenceContent(request.params.id);
    image.headers.forEach((value, key) => response.set(key, value));
    response.status(image.status).send(Buffer.from(await image.arrayBuffer()));
  });
  app.use("/api/admin/ai", createAiRouter(ai.service, store, requireAuth, true));
  app.use("/api/ai", createAiRouter(ai.service, store, requireAuth, false, dify));
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
  if (options.startAiAgentScheduler) aiAgentScheduler.start();

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      await aiAgentScheduler.stop();
      await loraCollector.stop();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
    } finally {
      // Supertest creates its own HTTP server around app, so this server may
      // never have listened. SQLite must still close before Windows can remove it.
      ai.close();
    }
  })();
  return { app, server, store, loraCollector, aiAgentScheduler, aiStore: ai.store, closeAi: ai.close, close };
}
