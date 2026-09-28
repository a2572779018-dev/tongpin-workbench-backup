import { AlertTriangle, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiHarnessConfig, AiObservabilityAlert, AiObservabilityDashboard } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { harnessProviderLabel } from "./adminAiLayout";
import {
  ADMIN_AI_ALERT_ENDPOINT,
  ADMIN_AI_ALERT_POLL_MS,
  adminAiAlertNotificationId,
  readAdminAiAlertMemory,
  reduceAdminAiAlertPoll,
  summarizeAdminAiAlerts,
  writeAdminAiAlertMemory,
  type AdminAiAlertDescription,
  type AdminAiAlertMemory,
} from "./adminAiAlertWatch";
import { adminAiAlertStorage, onAdminAiMonitoringNoticeAction, showAdminAiAlertDesktopNotice } from "../../lib/adminAiAlertDesktop";
import "./AdminAiAlertCenter.css";

export interface AdminAiAlertCenterValue {
  /** Open alerts the admin has not yet looked at on 运行监控 (drives the tab red dot). */
  unviewedCount: number;
  /** Set when a toast/desktop notice asked to jump to 运行监控; the panel consumes it. */
  monitoringRequested: boolean;
  consumeMonitoringRequest(): void;
  /** The panel reports whether 运行监控 is on screen; opening it acknowledges (views) open alerts. */
  setMonitoringVisible(visible: boolean): void;
  /** Called by 运行监控 with each dashboard it loads while on screen. */
  markViewed(dashboard: Pick<AiObservabilityDashboard, "alerts">): void;
}

const inert: AdminAiAlertCenterValue = {
  unviewedCount: 0,
  monitoringRequested: false,
  consumeMonitoringRequest: () => undefined,
  setMonitoringVisible: () => undefined,
  markViewed: () => undefined,
};

const AdminAiAlertContext = createContext<AdminAiAlertCenterValue>(inert);

export function useAdminAiAlertCenter(): AdminAiAlertCenterValue {
  return useContext(AdminAiAlertContext);
}

const appHasFocus = () => document.visibilityState === "visible" && document.hasFocus();

function notifyDesktop(summary: AdminAiAlertDescription, alerts: AiObservabilityAlert[], onOpen: () => void): void {
  if (appHasFocus()) return; // The in-app banner is enough while the admin is looking at 同频.
  void showAdminAiAlertDesktopNotice({ notificationId: adminAiAlertNotificationId(alerts), title: summary.title, body: summary.body }, onOpen);
}

export function AdminAiAlertCenter({ enabled, userId, onOpenMonitoring, children }: {
  /** True only for a logged-in administrator; members never poll or render anything. */
  enabled: boolean;
  userId: string | null;
  onOpenMonitoring: () => void;
  children: ReactNode;
}) {
  const { api } = useAuth();
  const active = enabled && Boolean(userId);
  const memory = useRef<AdminAiAlertMemory>({ notified: [], viewed: [] });
  const monitoringVisible = useRef(false);
  const lastDashboard = useRef<Pick<AiObservabilityDashboard, "alerts"> | null>(null);
  const announce = useRef<(fresh: AiObservabilityAlert[]) => Promise<void>>(async () => undefined);
  const harness = useRef<AiHarnessConfig | null | undefined>(undefined);
  const openMonitoringRef = useRef(onOpenMonitoring);
  openMonitoringRef.current = onOpenMonitoring;
  const [unviewedCount, setUnviewedCount] = useState(0);
  const [monitoringRequested, setMonitoringRequested] = useState(false);
  const [toast, setToast] = useState<{ ids: string[]; summary: AdminAiAlertDescription } | null>(null);

  const persist = useCallback(() => {
    if (userId) writeAdminAiAlertMemory(adminAiAlertStorage(), userId, memory.current);
  }, [userId]);

  const openMonitoring = useCallback(() => {
    setToast(null);
    setMonitoringRequested(true);
    openMonitoringRef.current();
  }, []);

  // 运行监控 only counts as seen while 同频 itself is on screen and focused:
  // a selected tab in a hidden or background window must not swallow alerts.
  const seenNow = () => monitoringVisible.current && appHasFocus();
  const apply = useCallback((dashboard: Pick<AiObservabilityDashboard, "alerts">, visible: boolean) => {
    lastDashboard.current = dashboard;
    const result = reduceAdminAiAlertPoll(dashboard, memory.current, { monitoringVisible: visible });
    memory.current = result.memory;
    persist();
    setUnviewedCount(result.unviewed.length);
    if (visible) setToast(null);
    return result;
  }, [persist]);

  useEffect(() => {
    memory.current = active && userId ? readAdminAiAlertMemory(adminAiAlertStorage(), userId) : { notified: [], viewed: [] };
    harness.current = undefined;
    lastDashboard.current = null;
    setUnviewedCount(0);
    setToast(null);
    setMonitoringRequested(false);
    if (!active) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const providerLabel = async () => {
      if (harness.current === undefined) {
        harness.current = await api<{ harness: AiHarnessConfig | null }>("/api/admin/ai/harness")
          .then(result => result.harness).catch(() => null);
      }
      return (id: string) => harnessProviderLabel(harness.current, id);
    };
    announce.current = async (fresh: AiObservabilityAlert[]) => {
      const summary = summarizeAdminAiAlerts(fresh, await providerLabel());
      if (disposed || !summary) return;
      setToast({ ids: fresh.map(alert => alert.id), summary });
      notifyDesktop(summary, fresh, openMonitoring);
    };
    // Also while the window is hidden or minimized (to the tray on Windows):
    // that is when a desktop notice matters most.
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const dashboard = await api<AiObservabilityDashboard>(ADMIN_AI_ALERT_ENDPOINT, { signal: controller.signal });
        if (disposed) return;
        const result = apply(dashboard, seenNow());
        if (result.fresh.length) await announce.current(result.fresh);
      } catch {
        // Background watch is best-effort; 运行监控 itself shows load errors.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), ADMIN_AI_ALERT_POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    // Coming back to 同频 while 运行监控 is open counts as looking at it.
    const onFocus = () => { if (seenNow() && lastDashboard.current) apply(lastDashboard.current, true); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    const stopDesktopAction = onAdminAiMonitoringNoticeAction(openMonitoring);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      announce.current = async () => undefined;
      stopDesktopAction();
    };
  }, [active, userId, api, apply, openMonitoring]);

  const consumeMonitoringRequest = useCallback(() => setMonitoringRequested(false), []);
  const setMonitoringVisible = useCallback((visible: boolean) => {
    if (monitoringVisible.current === visible) return;
    monitoringVisible.current = visible;
    if (visible && lastDashboard.current && appHasFocus()) apply(lastDashboard.current, true);
  }, [apply]);
  const markViewed = useCallback((dashboard: Pick<AiObservabilityDashboard, "alerts">) => {
    if (!monitoringVisible.current) return;
    // The dashboard keeps refreshing in a background window: announce what is new there.
    const result = apply(dashboard, appHasFocus());
    if (result.fresh.length) void announce.current(result.fresh);
  }, [apply]);

  const value = useMemo<AdminAiAlertCenterValue>(() => active ? {
    unviewedCount,
    monitoringRequested,
    consumeMonitoringRequest,
    setMonitoringVisible,
    markViewed,
  } : inert, [active, unviewedCount, monitoringRequested, consumeMonitoringRequest, setMonitoringVisible, markViewed]);

  return <AdminAiAlertContext.Provider value={value}>
    {children}
    {active && toast ? <aside className="tp-admin-ai-alert-toast" role="alert" aria-label="AI 运行告警">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <strong>{toast.summary.title}</strong>
        <ul>{toast.summary.lines.map(line => <li key={line}>{line}</li>)}</ul>
        <div className="tp-admin-ai-alert-toast__actions">
          <button type="button" className="is-primary" onClick={openMonitoring}>查看运行监控</button>
          <button type="button" onClick={() => setToast(null)}>稍后处理</button>
        </div>
      </div>
      <button type="button" className="tp-admin-ai-alert-toast__close" aria-label="关闭告警提示" onClick={() => setToast(null)}><X size={16} /></button>
    </aside> : null}
  </AdminAiAlertContext.Provider>;
}
