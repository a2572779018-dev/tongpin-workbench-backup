import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES,
  RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE,
} from "../shared/relationshipGraphMirror";
import {
  bossRelationshipGraphResponseBody,
  parseRelationshipGraphUpload,
  relationshipGraphTenantId,
  splitRelationshipGraphChunks,
} from "./relationship-graph-snapshots";

class TestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string) =>
  new TestError(status, code, message);

function graph(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    title: "已合作客户脉络图",
    generatedAt: "2026-09-26T08:00:00.000Z",
    colorSemantics: { yellow: "核心", blue: "普通", pink: "关注", green: "新客户" },
    people: [
      { id: "self", name: "你", level: "self", avatar: null },
      { id: "wang", name: "王总", level: "core", phone: "13800000000", avatar: null },
      { id: "li", name: "李经理", level: "close", avatar: "data:image/webp;base64,UklGRg==" },
    ],
    connections: [
      { source: "self", target: "wang", relationship: "客户引荐", strength: 0.7 },
      { source: "wang", target: "li", relationship: "客户引荐", strength: 0.7 },
    ],
    ...overrides,
  };
}

function upload(graphValue: unknown, overrides: Record<string, unknown> = {}) {
  return {
    graph: graphValue,
    localVersion: 3,
    contentHash: createHash("sha256").update(JSON.stringify(graphValue)).digest("hex"),
    updatedAt: "2026-09-26T08:00:00Z",
    avatarsOmitted: 1,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as TestError;
  }
  throw new Error("expected a rejection");
}

describe("relationship graph mirror validation (shared by Express and Worker)", () => {
  it("accepts a member upload after a JSON round trip and derives canonical metadata", async () => {
    // Same path as production: the client serializes the envelope, the server parses it.
    const body = JSON.parse(JSON.stringify(upload(graph())));
    const parsed = await parseRelationshipGraphUpload(body, fail);
    expect(parsed).toMatchObject({
      localVersion: 3,
      updatedAt: "2026-09-26T08:00:00.000Z",
      avatarsOmitted: 1,
      contactCount: 2,
      connectionCount: 2,
    });
    expect(parsed.serialized).toBe(JSON.stringify(graph()));
    expect(parsed.bytes).toBe(Buffer.byteLength(parsed.serialized, "utf8"));
  });

  it("ignores unknown top-level fields so newer clients keep syncing", async () => {
    const parsed = await parseRelationshipGraphUpload(
      { ...upload(graph()), futureField: { any: true } },
      fail,
    );
    expect(parsed.contactCount).toBe(2);
  });

  it("rejects a content hash that does not match the stored text", async () => {
    const error = await rejection(
      parseRelationshipGraphUpload(upload(graph(), { contentHash: "0".repeat(64) }), fail),
    );
    expect(error).toMatchObject({ status: 400, code: "RELATIONSHIP_GRAPH_HASH_MISMATCH" });
  });

  it("caps the mirror at 5 MB", async () => {
    const people = [
      { id: "self", name: "你", level: "self" },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `p${index}`,
        name: `客户${index}`,
        level: "core",
        note: "长".repeat(60_000),
      })),
    ];
    const large = graph({ people, connections: [] });
    expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeGreaterThan(
      RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES,
    );
    const error = await rejection(parseRelationshipGraphUpload(upload(large), fail));
    expect(error).toMatchObject({ status: 413, code: "RELATIONSHIP_GRAPH_TOO_LARGE" });
  });

  it.each([
    ["missing center", graph({ people: [{ id: "a", name: "甲", level: "core" }], connections: [] })],
    ["two centers", graph({ people: [{ id: "self", name: "你", level: "self" }, { id: "b", name: "乙", level: "self" }], connections: [] })],
    ["duplicate person id", graph({ people: [{ id: "self", name: "你", level: "self" }, { id: "self", name: "重复", level: "core" }], connections: [] })],
    ["dangling connection", graph({ connections: [{ source: "self", target: "ghost" }] })],
    ["self loop", graph({ connections: [{ source: "wang", target: "wang" }] })],
    ["unsafe avatar", graph({ people: [{ id: "self", name: "你", level: "self", avatar: "javascript:alert(1)" }], connections: [] })],
    ["original-size avatar", graph({ people: [{ id: "self", name: "你", level: "self", avatar: `data:image/png;base64,${"A".repeat(30_000)}` }], connections: [] })],
    ["wrong schema", graph({ schemaVersion: "2.0" })],
    ["too many people", graph({ people: Array.from({ length: RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE + 1 }, (_, index) => ({ id: index === 0 ? "self" : `p${index}`, name: "人", level: index === 0 ? "self" : "core" })), connections: [] })],
  ])("rejects an invalid graph: %s", async (_label, value) => {
    const error = await rejection(parseRelationshipGraphUpload(upload(value), fail));
    expect(error).toMatchObject({ status: 400, code: "RELATIONSHIP_GRAPH_INVALID" });
  });

  it.each([
    ["localVersion 0", { localVersion: 0 }],
    ["fractional localVersion", { localVersion: 1.5 }],
    ["short hash", { contentHash: "abc" }],
    ["invalid time", { updatedAt: "yesterday" }],
    ["negative avatar count", { avatarsOmitted: -1 }],
  ])("rejects invalid metadata: %s", async (_label, overrides) => {
    const error = await rejection(parseRelationshipGraphUpload(upload(graph(), overrides), fail));
    expect(error).toMatchObject({ status: 400, code: "RELATIONSHIP_GRAPH_INVALID" });
  });

  it("derives the organization only from the authenticated principal", () => {
    expect(relationshipGraphTenantId({ id: "u", role: "boss" }, fail)).toBe("default");
    expect(relationshipGraphTenantId({ tenantId: "acme" }, fail)).toBe("acme");
    expect(relationshipGraphTenantId({ tenant_id: "acme" }, fail)).toBe("acme");
    expect(() => relationshipGraphTenantId({ tenantId: "../x" }, fail)).toThrow(TestError);
    expect(() => relationshipGraphTenantId({ tenantId: "a", tenant_id: "b" }, fail)).toThrow(TestError);
  });

  it("splits into row-sized chunks without breaking surrogate pairs", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(9)}`;
    const chunks = splitRelationshipGraphChunks(text, 10);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("a".repeat(9));
    expect(chunks[1].startsWith("😀")).toBe(true);
    expect(splitRelationshipGraphChunks("x".repeat(25), 10).map((chunk) => chunk.length)).toEqual([10, 10, 5]);
  });

  it("embeds the stored graph text verbatim in the boss response", () => {
    const stored = JSON.stringify(graph());
    const body = bossRelationshipGraphResponseBody(
      { id: "u1", name: "小林" },
      {
        localVersion: 3,
        contentHash: "a".repeat(64),
        updatedAt: "2026-09-26T08:00:00.000Z",
        syncedAt: "2026-09-26T08:00:05.000Z",
        contactCount: 2,
        connectionCount: 2,
        avatarsOmitted: 0,
        bytes: stored.length,
      },
      stored,
    );
    expect(JSON.parse(body)).toEqual({
      user: { id: "u1", name: "小林" },
      snapshot: expect.objectContaining({ contactCount: 2 }),
      graph: graph(),
    });
  });
});
