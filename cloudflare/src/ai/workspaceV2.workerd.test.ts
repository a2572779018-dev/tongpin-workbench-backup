import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiWorkspaceState } from "../../../shared/aiWorkspace";
import { canonical, split } from "../../../server/ai/workspaceV2Shadow";

/** This is a local, isolated SQLite-DO fixture. It seeds a post-migration V2
 * account directly through Miniflare's test-only storage inspector because
 * production intentionally has no activation endpoint. All reads and writes
 * being accepted are then made through the real bundled Worker HTTP routes.
 * There are no provider requests, production accounts, or deployment calls. */
describe.sequential("V2 member routes in the bundled Worker after an account exceeds the V1 cap", () => {
  const WORKER = "tongpin-v2-workerd-acceptance";
  const HOST = "http://tongpin-v2-local.invalid";
  const PASSWORD = "V2WorkerdOnly20260924!";
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  type Session = { accessToken: string; user: { id: string; email: string; role: string } };
  type Failure = { error: { code: string; message: string } };
  let directory: string;
  let bundle: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  let other: Session;
  let outboundCalls = 0;

  const noOutbound: V4FetchHandler = async request => {
    outboundCalls++;
    throw new Error(`WP38 fixture blocked outbound request to ${new URL(request.url).host}`);
  };
  const start = () => new Miniflare({ ...convertV4MiniflareOptions({
    name: WORKER, modules: true, script: bundle,
    compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
    resourcePersistencePath: directory,
    bindings: {
      JWT_SECRET: "v2-workerd-isolated-secret-".repeat(4),
      BOOTSTRAP_ADMIN_EMAIL: "v2-admin@workerd.invalid", DEV_EMAIL_PREVIEW: "true",
      CLIENT_ORIGINS: HOST, AI_ALLOWED_HOSTS: "fixture.invalid",
      LORA_EXPLORER_API: "https://unused.invalid", LORA_RPC_URL: "https://unused.invalid",
    },
    outboundService: noOutbound, log: new Log(LogLevel.ERROR),
  }), unsafeInspectDurableObjects: true });

  async function call<T>(route: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await mf.dispatchFetch(`${HOST}${route}`, {
      method,
      headers: {
        ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T };
  }
  async function ok<T>(route: string, session?: Session, body?: unknown, method?: string): Promise<T> {
    const result = await call<T | Failure>(route, session, body, method);
    expect(result.status, `${method ?? "GET"} ${route}: ${JSON.stringify(result.body).slice(0, 250)}`).toBe(200);
    return result.body as T;
  }
  async function register(email: string, name: string) {
    const created = await call<{ debugCode: string; delivery: string }>("/api/auth/register", undefined, { email, name, password: PASSWORD });
    expect(created.status).toBe(201);
    expect(created.body.delivery).toBe("preview");
    await ok("/api/auth/verify-email", undefined, { email, code: created.body.debugCode });
  }
  const login = (email: string) => ok<Session>("/api/auth/login", undefined, { email, password: PASSWORD });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-v2-workerd-"));
    const built = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false,
      platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    bundle = built.outputFiles[0].text;
    mf = start(); await mf.ready;
    expect(await ok<{ storage: string }>("/api/health")).toMatchObject({ storage: "durable-object-sqlite" });
    await register("v2-admin@workerd.invalid", "V2 本地管理员");
    admin = await login("v2-admin@workerd.invalid");
    await register("v2-member@workerd.invalid", "V2 本地成员");
    await register("v2-other@workerd.invalid", "V2 隔离成员");
    const users = await ok<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    for (const email of ["v2-member@workerd.invalid", "v2-other@workerd.invalid"]) {
      const user = users.users.find(item => item.email === email)!;
      expect(user).toBeDefined();
      await ok(`/api/admin/users/${user.id}/access`, admin, { status: "active" }, "PATCH");
    }
    member = await login("v2-member@workerd.invalid");
    other = await login("v2-other@workerd.invalid");
    await ok(`/api/admin/ai/members/${member.user.id}/quota`, admin, { limitTokens: 1000 }, "PUT");
    await ok(`/api/admin/ai/members/${other.user.id}/quota`, admin, { limitTokens: 1000 }, "PUT");
  }, 30_000);
  afterAll(async () => {
    if (mf) await mf.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("continues V2 chat beyond 8 MiB, fences V1 and other accounts, and survives a real workerd restart", async () => {
    const media = { kind: "image" as const, frames: [{ dataUrl: `data:image/png;base64,${PNG}` }] };
    const sampledVideo = { kind: "video" as const, durationSeconds: 2,
      frames: [{ dataUrl: `data:image/png;base64,${PNG}`, timeSeconds: 1 }] };
    const original: AiWorkspaceState = {
      view: "chat", mode: "quick", activeConversationId: "long-chat", activeProjectId: null,
      enabledSkillIds: [], projects: [], drafts: {},
      conversations: [
        { id: "long-chat", title: "长对话", timeLabel: "刚刚", messages: [
          { id: "seed-image", role: "user", content: "看这张图", time: "10:00", attachments: [
            { id: "image-attachment", name: "测试图.png", mimeType: "image/png", content: "测试图", media },
            { id: "video-attachment", name: "测试片.mp4", mimeType: "video/mp4", content: "视频采样画面", media: sampledVideo },
          ] },
          { id: "seed-result", role: "assistant", content: "已生成成果", time: "10:01", artifactId: "seed-artifact" },
        ] },
        { id: "other-chat", title: "第二段", timeLabel: "刚刚", messages: [] },
      ],
      artifacts: [{ id: "seed-artifact", conversationId: "long-chat", title: "测试成果", kind: "presentation",
        updatedLabel: "刚刚", summary: "本地静态成果", sections: [{ heading: "摘要", lines: ["隔离 fixture"] }] }],
    };
    const initial = await ok<{ revision: number; state: AiWorkspaceState }>("/api/ai/workspace", member, {
      expectedRevision: 0, mutationId: crypto.randomUUID(), state: original,
    }, "PUT");
    expect(initial.revision).toBe(1);
    expect(await ok("/api/ai/workspace-v2/bootstrap", member)).toEqual({ schemaVersion: 1 });

    // Emulate a local test account that was migrated and then grew through
    // V2 writes. The only internal writes in this test are fixture seeding;
    // no activation route is added to TongpinCore or exposed to members.
    const large = structuredClone(original);
    for (let index = 0; index < 86; index++) large.conversations[0].messages.push({
      id: `historical-${index}`, role: "user", content: `第${index}条 ${"x".repeat(100_000)}`, time: "10:02",
    });
    const totalBytes = new TextEncoder().encode(JSON.stringify(large)).byteLength;
    expect(totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    const storage = await mf.unsafeGetDurableObjectStorage(WORKER, "TongpinCore", { name: "primary" });
    const tenant = "default", user = member.user.id;
    const timestamp = new Date().toISOString();
    for (const segment of split(large)) {
      const bytes = Buffer.from(JSON.stringify(segment.value), "utf8");
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 48 * 1024) chunks.push(bytes.subarray(offset, offset + 48 * 1024).toString("base64"));
      await storage.exec("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count,deleted) VALUES(?,?,?,?,1,?,?,?,?,0)",
        tenant, user, segment.kind, segment.entityId, segment.ordinal, bytes.length, digest(bytes.toString("utf8")), chunks.length);
      for (const [index, data] of chunks.entries()) await storage.exec(
        "INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,?,?,?,?)",
        tenant, user, segment.kind, segment.entityId, index, data);
    }
    for (const [ordinal, conversation] of large.conversations.entries()) {
      await storage.exec("INSERT INTO ai_workspace_v2_conversation_directory(tenant_id,user_id,conversation_id,title,time_label,project_id,ordinal,revision) VALUES(?,?,?,?,?,?,?,1)",
        tenant, user, conversation.id, conversation.title, conversation.timeLabel, conversation.projectId ?? null, ordinal);
      for (const message of conversation.messages) await storage.exec(
        "INSERT INTO ai_workspace_v2_message_owners(tenant_id,user_id,message_id,conversation_id) VALUES(?,?,?,?)",
        tenant, user, message.id, conversation.id);
    }
    await storage.exec("INSERT INTO ai_workspace_v2_meta(tenant_id,user_id,source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version) VALUES(?,?,?,?,1,?,?,1,1)",
      tenant, user, initial.revision, digest(canonical(original)), timestamp, timestamp);
    await storage.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=? AND revision=?", tenant, user, initial.revision);

    const root = "/api/ai/workspace-v2";
    const bootstrap = await ok<{ schemaVersion: number; epoch: number; conversations: Array<{ entityId: string }> }>(`${root}/bootstrap`, member);
    expect(bootstrap).toMatchObject({ schemaVersion: 2, epoch: 1 });
    expect(bootstrap.conversations.map(item => item.entityId)).toEqual(["long-chat", "other-chat"]);
    expect((await call<Failure>("/api/ai/workspace", member)).body.error.code).toBe("AI_WORKSPACE_VERSION_UNSUPPORTED");
    expect((await call<Failure>("/api/ai/workspace", member, {
      expectedRevision: 1, mutationId: crypto.randomUUID(), state: original,
    }, "PUT")).body.error.code).toBe("AI_WORKSPACE_VERSION_UNSUPPORTED");
    expect(await ok(`${root}/bootstrap`, other)).toEqual({ schemaVersion: 1 });
    expect((await call<Failure>(`${root}/conversations/long-chat/messages`, other)).status).toBe(409);
    expect(await ok(`${root}/artifacts/seed-artifact?conversationId=long-chat`, member)).toMatchObject({ artifact: { id: "seed-artifact" } });
    const before = await ok<{ revision: number; messages: Array<{ id: string }> }>(`${root}/conversations/long-chat/messages?limit=2`, member);
    expect(before.messages.at(-1)?.id).toBe("historical-85");
    const first = await ok<{ revision: number; messageIds: string[] }>(`${root}/append-user`, member, {
      epoch: 1, mutationId: crypto.randomUUID(), conversationId: "long-chat", expectedRevision: before.revision,
      message: { id: "post-cap-user", role: "user", content: "超过旧上限后继续聊", time: "11:00" },
    });
    expect(first.messageIds).toEqual(["post-cap-user"]);

    const requestId = crypto.randomUUID();
    const prompted = await ok<{ revision: number }>(`${root}/append-user`, member, {
      epoch: 1, mutationId: crypto.randomUUID(), conversationId: "long-chat", expectedRevision: first.revision,
      message: { id: "linked-user", role: "user", content: "再回复一句", time: "11:01", requestId },
    });
    const result = { requestId, content: "本地服务端回执：可以继续", model: "fixture-local",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } };
    await storage.exec("INSERT INTO ai_requests(user_id,tenant_id,request_id,data) VALUES(?,?,?,?)", user, tenant, requestId,
      JSON.stringify({ requestId, userId: user, conversationId: "long-chat", hash: "fixture", status: "completed", kind: "chat",
        createdAt: timestamp, expiresAt: Date.now() + 60_000, inputReserve: 0, outputReserve: 0,
        model: "fixture-local", mode: "quick", result }));
    const committed = await ok<{ revision: number }>(`${root}/commit-assistant`, member, {
      epoch: 1, mutationId: crypto.randomUUID(), conversationId: "long-chat", expectedRevision: prompted.revision,
      requestId, messageId: "linked-assistant",
    });
    expect(committed.revision).toBe(prompted.revision + 1);
    expect(await ok(`${root}/conversations/long-chat/messages?limit=3`, member)).toMatchObject({ messages: [
      { id: "post-cap-user" }, { id: "linked-user" }, { id: "linked-assistant", content: result.content },
    ] });

    const second = await ok<{ entities: Array<{ revision: number }> }>(`${root}/mutate`, member, {
      epoch: 1, mutationId: crypto.randomUUID(), ops: [{ kind: "conversation", entityId: "new-chat", expectedRevision: 0,
        action: "put", value: { id: "new-chat", title: "超限后新建", timeLabel: "刚刚", messages: [] } }],
    });
    expect(second.entities[0].revision).toBe(1);
    await ok(`${root}/append-user`, member, { epoch: 1, mutationId: crypto.randomUUID(), conversationId: "new-chat",
      expectedRevision: 1, message: { id: "new-chat-user", role: "user", content: "新对话也能保存", time: "11:02" } });
    const savedBytes = await storage.exec<{ total: number }>("SELECT SUM(byte_length) AS total FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND deleted=0", tenant, user);
    expect(savedBytes[0].total).toBeGreaterThan(8 * 1024 * 1024);
    expect(outboundCalls).toBe(0);

    await mf.dispose(); mf = start(); await mf.ready;
    const reopened = await ok<{ schemaVersion: number; conversations: Array<{ entityId: string }> }>(`${root}/bootstrap`, member);
    expect(reopened.schemaVersion).toBe(2);
    expect(reopened.conversations.map(item => item.entityId)).toEqual(["new-chat", "long-chat", "other-chat"]);
    expect(await ok(`${root}/conversations/long-chat/messages?limit=3`, member)).toMatchObject({ messages: [
      { id: "post-cap-user" }, { id: "linked-user" }, { id: "linked-assistant", content: result.content },
    ] });
    expect(await ok(`${root}/conversations/new-chat/messages`, member)).toMatchObject({ messages: [{ id: "new-chat-user" }] });
    expect(await ok(`${root}/artifacts/seed-artifact?conversationId=long-chat`, member)).toMatchObject({ artifact: { id: "seed-artifact" } });
    expect(await ok(`${root}/conversations/long-chat/messages?before=historical-0&limit=2`, member)).toMatchObject({ messages: [
      { id: "seed-image", attachments: [
        { id: "image-attachment", media: { kind: "image" } },
        { id: "video-attachment", media: { kind: "video", durationSeconds: 2 } },
      ] }, { id: "seed-result", artifactId: "seed-artifact" },
    ] });
    expect((await call<Failure>("/api/ai/workspace", member)).body.error.code).toBe("AI_WORKSPACE_VERSION_UNSUPPORTED");
    expect(outboundCalls).toBe(0);
  }, 120_000);
});
