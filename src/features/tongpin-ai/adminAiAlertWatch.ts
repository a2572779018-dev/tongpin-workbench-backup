import {
  AI_BUSINESS_TIER_LABELS,
  AI_OBSERVABILITY_CAPABILITY_LABELS,
  type AiMode,
  type AiObservabilityAlert,
  type AiObservabilityDashboard,
} from "../../../shared/ai";

/** Background alert watch for administrators; members never poll the admin endpoint. */
export const ADMIN_AI_ALERT_POLL_MS = 60_000;
export const ADMIN_AI_ALERT_ENDPOINT = "/api/admin/ai/observability?windowMinutes=60";
const STORAGE_PREFIX = "tongpin:admin-ai-alerts:v1:";
const MAX_REMEMBERED_IDS = 200;

export const ADMIN_AI_ALERT_KIND_LABELS: Record<AiObservabilityAlert["code"], string> = {
  HIGH_ERROR_RATE: "错误率过高",
  HIGH_LATENCY: "响应过慢",
  PROVIDER_UNAVAILABLE: "服务不可用",
};

/** `notified`: already toasted/desktop-notified. `viewed`: admin opened 运行监控 while it was active. */
export interface AdminAiAlertMemory { notified: string[]; viewed: string[] }

type ReadableStorage = Pick<Storage, "getItem"> | null | undefined;
type WritableStorage = Pick<Storage, "setItem"> | null | undefined;

export function adminAiAlertStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200).slice(-MAX_REMEMBERED_IDS) : [];

export function readAdminAiAlertMemory(storage: ReadableStorage, userId: string): AdminAiAlertMemory {
  try {
    const raw = storage?.getItem(adminAiAlertStorageKey(userId));
    if (!raw) return { notified: [], viewed: [] };
    const parsed = JSON.parse(raw) as Partial<AdminAiAlertMemory> | null;
    return { notified: idList(parsed?.notified), viewed: idList(parsed?.viewed) };
  } catch {
    return { notified: [], viewed: [] };
  }
}

export function writeAdminAiAlertMemory(storage: WritableStorage, userId: string, memory: AdminAiAlertMemory): void {
  try {
    storage?.setItem(adminAiAlertStorageKey(userId), JSON.stringify({
      notified: idList(memory.notified),
      viewed: idList(memory.viewed),
    }));
  } catch {
    // Private mode / quota errors: in-memory dedupe still applies for this session.
  }
}

/** Adds ids while keeping insertion order and the size bound (oldest dropped first). */
export function rememberAlertIds(current: readonly string[], ids: Iterable<string>): string[] {
  const next = current.filter(Boolean);
  const seen = new Set(next);
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next.slice(-MAX_REMEMBERED_IDS);
}

const isOpen = (alert: AiObservabilityAlert) => alert.resolvedAt === null && !alert.acknowledgedAt;

/** Active, not server-acknowledged alerts the admin has not been notified about yet. */
export function newAdminAiAlerts(dashboard: Pick<AiObservabilityDashboard, "alerts">, notified: ReadonlySet<string>): AiObservabilityAlert[] {
  return dashboard.alerts.filter(alert => isOpen(alert) && !notified.has(alert.id));
}

/** Drives the red dot on 运行监控: open alerts the admin has not looked at on that tab. */
export function unviewedAdminAiAlerts(dashboard: Pick<AiObservabilityDashboard, "alerts">, viewed: ReadonlySet<string>): AiObservabilityAlert[] {
  return dashboard.alerts.filter(alert => isOpen(alert) && !viewed.has(alert.id));
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (milliseconds: number) => `${Math.round(milliseconds / 1000)} 秒`;

export interface AdminAiAlertDescription { title: string; lines: string[]; body: string }

/** Plain-Chinese alert summary: tier, service display name, capability, rate and error code. */
export function describeAdminAiAlert(alert: AiObservabilityAlert, providerLabel: (providerId: string) => string = id => id): AdminAiAlertDescription {
  const tier = alert.tier === "all" ? "不分档位" : `${AI_BUSINESS_TIER_LABELS[alert.tier as AiMode] ?? alert.tier}档`;
  const capability = AI_OBSERVABILITY_CAPABILITY_LABELS[alert.capability] ?? alert.capability;
  const kind = ADMIN_AI_ALERT_KIND_LABELS[alert.code] ?? alert.code;
  const severity = alert.severity === "critical" ? "严重告警" : "预警";
  const detail = alert.detail;
  const stage = detail?.operation === "planning" ? "（规划阶段）" : "";
  const lines = [
    `服务：${providerLabel(alert.provider) || alert.provider}`,
    `档位与能力：${tier} · ${capability}${stage}`,
  ];
  if (detail) {
    lines.push(alert.code === "HIGH_LATENCY"
      ? `最大响应：${seconds(detail.maxLatencyMs)}（最近 60 分钟 ${detail.requests} 次请求，失败 ${detail.failures} 次）`
      : `错误率：${percent(detail.errorRate)}（最近 60 分钟 ${detail.requests} 次请求，失败 ${detail.failures} 次）`);
    lines.push(`错误码：${detail.errors.length ? detail.errors.map(error => `${error.code} × ${error.count}`).join("、") : "无"}`);
  } else {
    lines.push(`详情：${alert.message}`);
  }
  lines.push(`告警类型：${kind}（${alert.code}）`);
  return { title: `${severity}：${tier} · ${capability}${kind}`, lines, body: lines.join("；") };
}

/** One notification for a batch of new alerts (most severe first). */
export function summarizeAdminAiAlerts(alerts: readonly AiObservabilityAlert[], providerLabel?: (providerId: string) => string): AdminAiAlertDescription | null {
  if (!alerts.length) return null;
  const sorted = [...alerts].sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "critical" ? -1 : 1));
  const first = describeAdminAiAlert(sorted[0], providerLabel);
  if (sorted.length === 1) return first;
  const more = `另有 ${sorted.length - 1} 条新告警，请到 AI 管理 → 运行监控查看。`;
  return { title: `${first.title}（共 ${sorted.length} 条）`, lines: [...first.lines, more], body: `${first.body}；${more}` };
}

export function adminAiAlertNotificationId(alerts: readonly AiObservabilityAlert[]): string {
  return `admin-ai-alert:${alerts.map(alert => alert.id).join(",")}`.slice(0, 80);
}

export interface AdminAiAlertPollResult {
  memory: AdminAiAlertMemory;
  /** Alerts to announce now (toast + desktop notice). Empty while 运行监控 is on screen. */
  fresh: AiObservabilityAlert[];
  /** Alerts that keep the 运行监控 red dot on. */
  unviewed: AiObservabilityAlert[];
}

/** Pure reducer for one poll: dedupe by alert id and treat an on-screen 运行监控 tab as viewed. */
export function reduceAdminAiAlertPoll(
  dashboard: Pick<AiObservabilityDashboard, "alerts">,
  memory: AdminAiAlertMemory,
  options: { monitoringVisible: boolean },
): AdminAiAlertPollResult {
  const open = dashboard.alerts.filter(isOpen);
  if (options.monitoringVisible) {
    const ids = open.map(alert => alert.id);
    return {
      memory: { notified: rememberAlertIds(memory.notified, ids), viewed: rememberAlertIds(memory.viewed, ids) },
      fresh: [],
      unviewed: [],
    };
  }
  const fresh = newAdminAiAlerts(dashboard, new Set(memory.notified));
  return {
    memory: { notified: rememberAlertIds(memory.notified, fresh.map(alert => alert.id)), viewed: memory.viewed },
    fresh,
    unviewed: unviewedAdminAiAlerts(dashboard, new Set(memory.viewed)),
  };
}
