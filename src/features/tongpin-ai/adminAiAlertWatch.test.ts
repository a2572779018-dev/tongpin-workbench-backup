import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiObservabilityAlert } from "../../../shared/ai";
import {
  ADMIN_AI_ALERT_ENDPOINT,
  ADMIN_AI_ALERT_POLL_MS,
  adminAiAlertStorageKey,
  canWatchAdminAiAlerts,
  describeAdminAiAlert,
  readAdminAiAlertMemory,
  reduceAdminAiAlertPoll,
  rememberAlertIds,
  summarizeAdminAiAlerts,
  writeAdminAiAlertMemory,
} from "./adminAiAlertWatch";

const alert = (overrides: Partial<AiObservabilityAlert> = {}): AiObservabilityAlert => ({
  id: "a1",
  code: "HIGH_ERROR_RATE",
  severity: "critical",
  tier: "deep",
  provider: "primary",
  capability: "chat",
  message: "deep · chat 错误率 100%",
  firstSeenAt: "2026-09-26T00:00:00.000Z",
  lastSeenAt: "2026-09-26T00:01:00.000Z",
  occurrences: 4,
  acknowledgedAt: null,
  resolvedAt: null,
  detail: { operation: "execution", requests: 4, failures: 3, errorRate: 0.75, maxLatencyMs: 65_000, errors: [{ code: "UPSTREAM_REJECTED", count: 3 }] },
  ...overrides,
});

describe("admin AI alert watch", () => {
  it("only watches for administrators, every ~60s, on the existing endpoint", () => {
    expect(canWatchAdminAiAlerts("admin")).toBe(true);
    expect(canWatchAdminAiAlerts("member")).toBe(false);
    expect(canWatchAdminAiAlerts("boss")).toBe(false);
    expect(canWatchAdminAiAlerts(undefined)).toBe(false);
    expect(ADMIN_AI_ALERT_POLL_MS).toBe(60_000);
    expect(ADMIN_AI_ALERT_ENDPOINT).toBe("/api/admin/ai/observability?windowMinutes=60");
  });

  it("describes alerts in plain Chinese with tier, service name, capability, rate and error code", () => {
    const text = describeAdminAiAlert(alert(), id => (id === "primary" ? "主力服务" : id));
    expect(text.title).toContain("严重告警");
    expect(text.body).toContain("服务：主力服务");
    expect(text.body).toContain("文字对话");
    expect(text.body).toContain("错误率：75%");
    expect(text.body).toContain("UPSTREAM_REJECTED × 3");
    expect(text.body).toContain("HIGH_ERROR_RATE");
    const latency = describeAdminAiAlert(alert({ code: "HIGH_LATENCY", severity: "warning" }));
    expect(latency.title).toContain("预警");
    expect(latency.body).toContain("最大响应：65 秒");
    const noDetail = describeAdminAiAlert(alert({ detail: undefined }));
    expect(noDetail.body).toContain("详情：deep · chat 错误率 100%");
  });

  it("summarizes a batch with the most severe alert first", () => {
    const summary = summarizeAdminAiAlerts([alert({ id: "w", severity: "warning", code: "HIGH_LATENCY" }), alert({ id: "c" })]);
    expect(summary?.title).toContain("严重告警");
    expect(summary?.title).toContain("共 2 条");
    expect(summarizeAdminAiAlerts([])).toBeNull();
  });

  it("announces each alert once and keeps the red dot until 运行监控 is viewed", () => {
    const dashboard = { alerts: [alert(), alert({ id: "acked", acknowledgedAt: "2026-09-26T00:02:00.000Z" }), alert({ id: "done", resolvedAt: "2026-09-26T00:03:00.000Z" })] };
    const first = reduceAdminAiAlertPoll(dashboard, { notified: [], viewed: [] }, { monitoringVisible: false });
    expect(first.fresh.map(item => item.id)).toEqual(["a1"]);
    expect(first.unviewed.map(item => item.id)).toEqual(["a1"]);
    const second = reduceAdminAiAlertPoll(dashboard, first.memory, { monitoringVisible: false });
    expect(second.fresh).toEqual([]);
    expect(second.unviewed.map(item => item.id)).toEqual(["a1"]);
    const viewed = reduceAdminAiAlertPoll(dashboard, second.memory, { monitoringVisible: true });
    expect(viewed.unviewed).toEqual([]);
    expect(reduceAdminAiAlertPoll(dashboard, viewed.memory, { monitoringVisible: false }).unviewed).toEqual([]);
  });

  it("does not announce alerts that appear while 运行监控 is on screen", () => {
    const result = reduceAdminAiAlertPoll({ alerts: [alert()] }, { notified: [], viewed: [] }, { monitoringVisible: true });
    expect(result.fresh).toEqual([]);
    expect(result.memory.notified).toEqual(["a1"]);
  });

  it("persists dedupe memory per user and survives broken storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    writeAdminAiAlertMemory(storage, "u1", { notified: ["a1"], viewed: [] });
    expect(store.has(adminAiAlertStorageKey("u1"))).toBe(true);
    expect(readAdminAiAlertMemory(storage, "u1")).toEqual({ notified: ["a1"], viewed: [] });
    expect(readAdminAiAlertMemory(storage, "u2")).toEqual({ notified: [], viewed: [] });
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(readAdminAiAlertMemory(broken, "u1")).toEqual({ notified: [], viewed: [] });
    expect(() => writeAdminAiAlertMemory(broken, "u1", { notified: ["a1"], viewed: [] })).not.toThrow();
    store.set(adminAiAlertStorageKey("u3"), "{not json");
    expect(readAdminAiAlertMemory(storage, "u3")).toEqual({ notified: [], viewed: [] });
  });

  it("bounds remembered ids", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const remembered = rememberAlertIds([], ids);
    expect(remembered).toHaveLength(200);
    expect(remembered[0]).toBe("id-50");
    expect(rememberAlertIds(["x"], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("mounts admin-only: members never poll, the shell only ignores the new desktop action", () => {
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    expect(app).toContain('enabled={session.user.role === "admin"}');
    const center = readFileSync(new URL("./AdminAiAlertCenter.tsx", import.meta.url), "utf8");
    expect(center).toContain("const active = enabled && Boolean(userId);");
    expect(center).toContain('document.visibilityState === "hidden"');
    expect(center).not.toMatch(/\bwindow\.tongpin\b|\blocalStorage\b/);
    const desktop = readFileSync(new URL("../../lib/adminAiAlertDesktop.ts", import.meta.url), "utf8");
    expect(desktop).toContain('Notification.permission !== "granted"');
    expect(desktop).not.toContain("requestPermission");
    const shell = readFileSync(new URL("../../components/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain('if (action.type === "open-admin-ai-monitoring") return;');
    expect(shell).not.toContain("AdminAiAlertCenter");
  });
});
