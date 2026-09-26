import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  RelationshipGraphSnapshotMeta,
  RelationshipGraphUploadRequest,
} from "../../shared/relationshipGraphMirror";
import { RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES } from "../../shared/relationshipGraphMirror";
import { parseRelationshipGraphUpload } from "../../server/relationship-graph-snapshots";
// @ts-expect-error The migrated storage module is covered by its own Vitest suite.
import { serializeGraphForStorage } from "../features/relationship-map/data/graphStorage.js";
import { ApiRequestError } from "./api";
import {
  buildRelationshipGraphMirror,
  classifyRelationshipGraphSyncError,
  createRelationshipGraphSync,
  describeRelationshipGraphSync,
  RELATIONSHIP_GRAPH_BOSS_NOTE,
  RELATIONSHIP_GRAPH_MIRROR_AVATAR_BUDGET,
  RelationshipGraphMirrorTooLargeError,
  type RelationshipGraphMirror,
  type RelationshipGraphSyncStatus,
} from "./relationshipGraphSync";

const SMALL_AVATAR = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";
const LARGE_PNG = `data:image/png;base64,${"iVBORw0KGgo".repeat(4_000)}`;

function vaultContent(people: Array<Record<string, unknown>>) {
  const serialized = serializeGraphForStorage({
    title: "已合作客户脉络图",
    colorSemantics: { yellow: "核心", blue: "普通", pink: "关注", green: "新客户" },
    people: [
      { id: "self", name: "你", level: "self", relationship: "自己", tags: [], position: { x: 0, y: 0 } },
      ...people.map((person, index) => ({
        level: "core",
        relationship: "已合作客户",
        tags: [],
        position: { x: 200 + index, y: 10 },
        ...person,
      })),
    ],
    connections: people.map((person) => ({
      source: "self",
      target: person.id,
      relationship: "客户引荐",
      strength: 0.7,
    })),
  }) as { ok: boolean; content: string };
  expect(serialized.ok).toBe(true);
  return serialized.content;
}

class TestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
const serverFail = (status: number, code: string, message: string) =>
  new TestError(status, code, message);

describe("member relationship-graph mirror", () => {
  it("downscales large avatars, keeps small ones, omits the rest, and passes the server check", async () => {
    const content = vaultContent([
      { id: "big", name: "大头像", avatar: LARGE_PNG },
      { id: "small", name: "小头像", avatar: SMALL_AVATAR },
      { id: "broken", name: "坏头像", avatar: `data:image/jpeg;base64,${"/9j/".repeat(8_000)}` },
      { id: "plain", name: "无头像", avatar: null },
    ]);
    const thumbnail = vi.fn(async (dataUrl: string) =>
      dataUrl.startsWith("data:image/png") ? SMALL_AVATAR : null,
    );
    const mirror = await buildRelationshipGraphMirror(content, 7, { thumbnail });
    const people = (mirror.request.graph.people as Array<{ id: string; avatar: unknown; name: string }>);
    expect(Object.fromEntries(people.map((person) => [person.id, person.avatar ?? null]))).toEqual({
      self: null,
      big: SMALL_AVATAR,
      small: SMALL_AVATAR,
      broken: null,
      plain: null,
    });
    expect(mirror.request.avatarsOmitted).toBe(1);
    expect(mirror.request.localVersion).toBe(7);
    expect(mirror.request.updatedAt).toBe(JSON.parse(content).generatedAt);
    // The small avatar is already mirror-sized: only the two others are decoded.
    expect(thumbnail).toHaveBeenCalledTimes(2);
    // All text survives unchanged.
    expect(people.map((person) => person.name)).toEqual(["你", "大头像", "小头像", "坏头像", "无头像"]);
    expect(mirror.request.graph.connections).toEqual(JSON.parse(content).connections);

    const again = await buildRelationshipGraphMirror(content, 7, { thumbnail });
    expect(again.request.contentHash).toBe(mirror.request.contentHash);
    expect(mirror.request.contentHash).toBe(
      createHash("sha256").update(JSON.stringify(mirror.request.graph)).digest("hex"),
    );

    // Exactly what the server re-serializes and verifies after the HTTP round trip.
    const accepted = await parseRelationshipGraphUpload(
      JSON.parse(JSON.stringify(mirror.request)),
      serverFail,
    );
    expect(accepted).toMatchObject({ contactCount: 4, connectionCount: 4, bytes: mirror.bytes });
  });

  it("omits avatars without a thumbnailer and beyond the shared avatar budget", async () => {
    const withoutThumbnailer = await buildRelationshipGraphMirror(
      vaultContent([{ id: "big", name: "大头像", avatar: LARGE_PNG }]),
      1,
    );
    expect(withoutThumbnailer.request.avatarsOmitted).toBe(1);

    const avatar = `data:image/webp;base64,${"A".repeat(20_000)}`;
    const count = Math.ceil(RELATIONSHIP_GRAPH_MIRROR_AVATAR_BUDGET / avatar.length) + 5;
    const mirror = await buildRelationshipGraphMirror(
      vaultContent(Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `客户${index}`, avatar }))),
      1,
    );
    const kept = (mirror.request.graph.people as Array<{ avatar: unknown }>).filter((person) => person.avatar).length;
    expect(kept * avatar.length).toBeLessThanOrEqual(RELATIONSHIP_GRAPH_MIRROR_AVATAR_BUDGET);
    expect(kept + mirror.request.avatarsOmitted).toBe(count);
  });

  it("drops every avatar before giving up, and refuses graphs over 5 MB", async () => {
    const avatar = `data:image/webp;base64,${"B".repeat(20_000)}`;
    const document = {
      schemaVersion: "1.0",
      title: "大图",
      generatedAt: "2026-09-26T08:00:00.000Z",
      people: [
        { id: "self", name: "你", level: "self", avatar: null },
        { id: "a", name: "甲", level: "core", avatar },
        { id: "b", name: "乙", level: "core", avatar },
        { id: "big", name: "长备注", level: "core", avatar: null, note: "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES - 15_000) },
      ],
      connections: [],
    };
    // Text fits, text plus the two (already small) avatars does not.
    const fitted = await buildRelationshipGraphMirror(JSON.stringify(document), 2);
    expect(fitted.bytes).toBeLessThanOrEqual(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES);
    expect(fitted.request.avatarsOmitted).toBe(2);
    expect((fitted.request.graph.people as Array<{ avatar: unknown }>).every((person) => person.avatar === null)).toBe(true);

    document.people[3].note = "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES + 1);
    await expect(buildRelationshipGraphMirror(JSON.stringify(document), 3)).rejects.toBeInstanceOf(
      RelationshipGraphMirrorTooLargeError,
    );
  });
});

function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const settle = async () => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    settle,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

function snapshot(content: string, patch: Partial<RelationshipGraphSnapshotMeta> = {}): RelationshipGraphSnapshotMeta {
  return {
    localVersion: 1,
    contentHash: hashOf(content),
    updatedAt: "2026-09-26T08:00:00.000Z",
    syncedAt: "2026-09-26T08:00:05.000Z",
    contactCount: 1,
    connectionCount: 1,
    avatarsOmitted: 0,
    bytes: content.length,
    ...patch,
  };
}

function harness(options: {
  upload?: (request: RelationshipGraphUploadRequest) => Promise<{ snapshot: RelationshipGraphSnapshotMeta }>;
  fetchRemote?: () => Promise<{ snapshot: RelationshipGraphSnapshotMeta | null }>;
  buildMirror?: (content: string, revision: number) => Promise<RelationshipGraphMirror>;
  onStatus?: (status: RelationshipGraphSyncStatus) => void;
} = {}) {
  const clock = fakeClock();
  const uploads: RelationshipGraphUploadRequest[] = [];
  const statuses: RelationshipGraphSyncStatus[] = [];
  const upload = vi.fn(
    options.upload ??
      (async (request: RelationshipGraphUploadRequest) => {
        uploads.push(request);
        return {
          snapshot: snapshot(String(request.graph.content), {
            localVersion: request.localVersion,
            syncedAt: new Date(clock.now()).toISOString(),
          }),
        };
      }),
  );
  const fetchRemote = vi.fn(options.fetchRemote ?? (async () => ({ snapshot: null })));
  const buildMirror = vi.fn(
    options.buildMirror ??
      (async (content: string, revision: number): Promise<RelationshipGraphMirror> => ({
        request: {
          graph: { content },
          localVersion: revision,
          contentHash: hashOf(content),
          updatedAt: "2026-09-26T09:00:00.000Z",
          avatarsOmitted: 0,
        },
        bytes: content.length,
      })),
  );
  const sync = createRelationshipGraphSync({
    upload,
    fetchRemote,
    buildMirror,
    onStatus: options.onStatus ?? ((status) => statuses.push(status)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, sync, upload, fetchRemote, buildMirror, uploads, statuses, phases: () => statuses.map((status) => status.phase) };
}

describe("member relationship-graph sync controller", () => {
  it("debounces bursts of local saves into one upload of the newest graph", async () => {
    const { clock, sync, upload, uploads, phases } = harness();
    sync.noteSaved({ content: "v1", revision: 1 });
    await clock.advance(2_000);
    sync.noteSaved({ content: "v2", revision: 2 });
    await clock.advance(2_000);
    sync.noteSaved({ content: "v3", revision: 3 });
    await clock.advance(7_900);
    expect(upload).not.toHaveBeenCalled();
    await clock.advance(200);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploads[0]).toMatchObject({ graph: { content: "v3" }, localVersion: 3 });
    expect(phases()).toEqual(["pending", "syncing", "synced"]);
    expect(sync.status().syncedAt).not.toBeNull();
  });

  it("uploads at least every 45 seconds while the member keeps editing", async () => {
    const { clock, sync, uploads } = harness();
    for (let index = 1; index <= 12; index += 1) {
      sync.noteSaved({ content: `v${index}`, revision: index });
      await clock.advance(5_000);
    }
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    expect(uploads[0].localVersion).toBeLessThanOrEqual(10);
  });

  it("isolates failures: retries transient errors with backoff and never throws into saving", async () => {
    let attempts = 0;
    const { clock, sync, upload, phases } = harness({
      upload: async (request) => {
        attempts += 1;
        if (attempts <= 2) throw new ApiRequestError(0, "NETWORK_UNAVAILABLE", "连接不上公司服务器");
        return { snapshot: snapshot(String(request.graph.content)) };
      },
    });
    expect(() => sync.noteSaved({ content: "v1", revision: 1 })).not.toThrow();
    await clock.advance(8_000);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sync.status().phase).toBe("retrying");
    await clock.advance(14_000);
    expect(upload).toHaveBeenCalledTimes(1);
    await clock.advance(1_000);
    expect(upload).toHaveBeenCalledTimes(2);
    await clock.advance(30_000);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(sync.status().phase).toBe("synced");
    expect(phases()).toContain("retrying");
  });

  it("does not retry client errors until the next local save", async () => {
    let fail = true;
    const { clock, sync, upload } = harness({
      upload: async (request) => {
        if (fail) throw new ApiRequestError(400, "RELATIONSHIP_GRAPH_INVALID", "客户脉络图格式无效");
        return { snapshot: snapshot(String(request.graph.content)) };
      },
    });
    sync.noteSaved({ content: "v1", revision: 1 });
    await clock.advance(8_000);
    expect(sync.status().phase).toBe("failed");
    expect(clock.pending()).toBe(0);
    await clock.advance(600_000);
    expect(upload).toHaveBeenCalledTimes(1);
    fail = false;
    sync.noteSaved({ content: "v2", revision: 2 });
    await clock.advance(8_000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sync.status().phase).toBe("synced");
  });

  it("backs off for ten minutes when the backend does not offer the route yet", async () => {
    let available = false;
    const { clock, sync, upload } = harness({
      upload: async (request) => {
        if (!available) throw new ApiRequestError(404, "NOT_FOUND", "请求的接口不存在");
        return { snapshot: snapshot(String(request.graph.content)) };
      },
    });
    sync.noteSaved({ content: "v1", revision: 1 });
    await clock.advance(8_000);
    expect(sync.status().phase).toBe("unavailable");
    expect(clock.pending()).toBe(0);
    sync.noteSaved({ content: "v2", revision: 2 });
    await clock.advance(8_000);
    await clock.advance(9 * 60_000);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sync.status().phase).toBe("unavailable");
    available = true;
    // The change saved during the cooldown goes up when it ends, without another save.
    await clock.advance(60_000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0]).toMatchObject({ graph: { content: "v2" }, localVersion: 2 });
    expect(sync.status().phase).toBe("synced");
    expect(clock.pending()).toBe(0);
  });

  it("reports graphs over the size cap without uploading", async () => {
    const { clock, sync, upload } = harness({
      buildMirror: async () => {
        throw new RelationshipGraphMirrorTooLargeError();
      },
    });
    sync.noteSaved({ content: "huge", revision: 1 });
    await clock.advance(8_000);
    expect(upload).not.toHaveBeenCalled();
    expect(sync.status().phase).toBe("too-large");
  });

  it("after opening uploads only when the server copy is missing or older", async () => {
    const missing = harness();
    missing.sync.noteLoaded({ content: "local", revision: 4 });
    await missing.clock.advance(1_500);
    expect(missing.fetchRemote).toHaveBeenCalledTimes(1);
    expect(missing.upload).toHaveBeenCalledTimes(1);

    const same = harness({ fetchRemote: async () => ({ snapshot: snapshot("local") }) });
    same.sync.noteLoaded({ content: "local", revision: 4 });
    await same.clock.advance(1_500);
    expect(same.upload).not.toHaveBeenCalled();
    expect(same.sync.status()).toMatchObject({ phase: "synced", syncedAt: "2026-09-26T08:00:05.000Z" });

    const older = harness({
      fetchRemote: async () => ({ snapshot: snapshot("previous", { updatedAt: "2026-09-26T07:00:00.000Z" }) }),
    });
    older.sync.noteLoaded({ content: "local", revision: 4 });
    await older.clock.advance(1_500);
    expect(older.upload).toHaveBeenCalledTimes(1);

    const newer = harness({
      fetchRemote: async () => ({ snapshot: snapshot("other-computer", { updatedAt: "2026-09-26T10:00:00.000Z" }) }),
    });
    newer.sync.noteLoaded({ content: "local", revision: 4 });
    await newer.clock.advance(1_500);
    expect(newer.upload).not.toHaveBeenCalled();
    expect(newer.sync.status().phase).toBe("elsewhere");
    // The next local save on this computer wins again.
    newer.sync.noteSaved({ content: "local-edit", revision: 5 });
    await newer.clock.advance(8_000);
    expect(newer.upload).toHaveBeenCalledTimes(1);
    expect(newer.fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("uploads the newest graph after a save that happened during an upload", async () => {
    let release: () => void = () => undefined;
    const uploads: string[] = [];
    const { clock, sync, phases } = harness({
      upload: async (request) => {
        uploads.push(String(request.graph.content));
        if (uploads.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        return { snapshot: snapshot(String(request.graph.content)) };
      },
    });
    sync.noteSaved({ content: "v1", revision: 1 });
    await clock.advance(8_000);
    sync.noteSaved({ content: "v2", revision: 2 });
    await clock.advance(8_000);
    expect(uploads).toEqual(["v1"]);
    release();
    await clock.settle();
    await clock.advance(0);
    expect(uploads).toEqual(["v1", "v2"]);
    expect(sync.status().phase).toBe("synced");
    // The finished stale upload never claimed the newer graph was synced.
    const staleIndex = phases().lastIndexOf("pending");
    expect(staleIndex).toBeGreaterThan(phases().indexOf("syncing"));
  });

  it("does not upload identical content twice", async () => {
    const { clock, sync, upload } = harness();
    sync.noteSaved({ content: "same", revision: 1 });
    await clock.advance(8_000);
    sync.noteSaved({ content: "same", revision: 1 });
    await clock.advance(8_000);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sync.status().phase).toBe("synced");
  });

  it("flushes a pending upload once on dispose and stays silent afterwards", async () => {
    const flushed = harness();
    flushed.sync.noteSaved({ content: "leaving", revision: 1 });
    const statusCount = flushed.statuses.length;
    flushed.sync.dispose({ flush: true });
    await flushed.clock.settle();
    expect(flushed.upload).toHaveBeenCalledTimes(1);
    expect(flushed.statuses).toHaveLength(statusCount);
    flushed.sync.noteSaved({ content: "after", revision: 2 });
    await flushed.clock.advance(60_000);
    expect(flushed.upload).toHaveBeenCalledTimes(1);

    const dropped = harness();
    dropped.sync.noteSaved({ content: "leaving", revision: 1 });
    dropped.sync.dispose();
    await dropped.clock.advance(60_000);
    expect(dropped.upload).not.toHaveBeenCalled();
  });

  it("stops for good after the signed-in account changed", async () => {
    const { clock, sync, upload } = harness({
      upload: async () => {
        throw new ApiRequestError(409, "AI_ACCOUNT_CHANGED", "账号已切换，请重新打开工作台");
      },
    });
    sync.noteSaved({ content: "v1", revision: 1 });
    await clock.advance(8_000);
    sync.noteSaved({ content: "v2", revision: 2 });
    await clock.advance(600_000);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("ignores empty vaults and status listener failures", async () => {
    const { clock, sync, upload, fetchRemote } = harness({
      onStatus: () => {
        throw new Error("render failed");
      },
    });
    sync.noteLoaded({ content: null, revision: 0 });
    sync.noteSaved({ content: "x", revision: 0 });
    await clock.advance(60_000);
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(() => sync.noteSaved({ content: "ok", revision: 1 })).not.toThrow();
    await clock.advance(8_000);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("classifies API failures", () => {
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "x"))).toBe("transient");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(503, "RELATIONSHIP_GRAPH_SYNC_BUSY", "x"))).toBe("transient");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(429, "RATE_LIMITED", "x"))).toBe("transient");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(413, "PAYLOAD_TOO_LARGE", "x"))).toBe("too-large");
    expect(classifyRelationshipGraphSyncError(new RelationshipGraphMirrorTooLargeError())).toBe("too-large");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(404, "NOT_FOUND", "x"))).toBe("unavailable");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(403, "FORBIDDEN", "x"))).toBe("blocked");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(401, "SESSION_INVALID", "x"))).toBe("blocked");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(409, "AI_ACCOUNT_CHANGED", "x"))).toBe("account-changed");
    expect(classifyRelationshipGraphSyncError(new ApiRequestError(400, "RELATIONSHIP_GRAPH_INVALID", "x"))).toBe("failed");
    expect(classifyRelationshipGraphSyncError(new Error("unexpected"))).toBe("transient");
  });

  it("always shows the boss transparency note with a compact status", () => {
    const now = Date.parse("2026-09-26T10:00:00.000Z");
    const base = { syncedAt: null, avatarsOmitted: 0 };
    expect(describeRelationshipGraphSync({ phase: "idle", ...base }, now)).toEqual({
      tone: "muted",
      text: RELATIONSHIP_GRAPH_BOSS_NOTE,
    });
    expect(RELATIONSHIP_GRAPH_BOSS_NOTE).toBe("客户脉络图会同步给老板查看");
    const synced = describeRelationshipGraphSync(
      { phase: "synced", syncedAt: new Date(now - 60_000).toISOString(), avatarsOmitted: 0 },
      now,
    );
    expect(synced.tone).toBe("ok");
    expect(synced.text).toMatch(/^客户脉络图会同步给老板查看 · 已同步 \d{2}:\d{2}$/);
    for (const phase of ["retrying", "too-large", "unavailable", "blocked", "failed"] as const) {
      const described = describeRelationshipGraphSync({ phase, ...base }, now);
      expect(described.tone).toBe("warn");
      expect(described.text.startsWith(`${RELATIONSHIP_GRAPH_BOSS_NOTE} · `)).toBe(true);
    }
  });
});
