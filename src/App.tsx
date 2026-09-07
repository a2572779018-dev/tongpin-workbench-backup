import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LogOut, RefreshCw, WifiOff } from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { flushAiBeforeLeave } from "./features/tongpin-ai/workspaceLeaveGuard";
import { AppShell, type AppView } from "./components/AppShell";
import { CustomCursor } from "./components/CustomCursor";
import { DesktopTitlebar } from "./components/DesktopTitlebar";
import { QuickTaskBridge } from "./components/QuickTaskBridge";
import { RelationshipMapErrorBoundary } from "./components/RelationshipMapErrorBoundary";
import { AdminConsole } from "./pages/AdminConsole";
import { AuthPage } from "./pages/AuthPage";
import { BossDashboard } from "./pages/BossDashboard";
import { LoraChainDashboard } from "./pages/LoraChainDashboard";
import { MemberHome } from "./pages/MemberHome";
import {
  isLaneHomeLayout,
  readHomeLayout,
  saveHomeLayout,
  type HomeLayout,
} from "./lib/homeLayout";
import {
  canAccessLoraDashboard,
  roleAllowsAppView,
} from "./lib/loraDashboardAccess";

const RelationshipMapPage = lazy(async () => {
  const module = await import("./pages/RelationshipMapPage");
  return { default: module.RelationshipMapPage };
});

const TongpinAIPage = lazy(async () => {
  const module = await import("./pages/TongpinAIPage");
  return { default: module.TongpinAIPage };
});

const AdminAiQuotaPanel = lazy(async () => {
  const module = await import("./features/tongpin-ai/AdminAiQuotaPanel");
  return { default: module.AdminAiQuotaPanel };
});

export function App() {
  const {
    loading,
    session,
    startupError,
    retryStartup,
    logout,
  } = useAuth();
  const [view, setView] = useState<AppView>("home");
  const [homeLayout, setHomeLayout] = useState<HomeLayout>("lanes");
  const relationshipExitInFlight = useRef(false);
  const currentAccountRef = useRef(session?.user.id);
  currentAccountRef.current = session?.user.id;

  const changeView = useCallback((nextView: AppView) => {
    if (nextView === view || relationshipExitInFlight.current) return;
    if (view === "ai" && session) {
      relationshipExitInFlight.current = true;
      const accountId = session.user.id;
      void flushAiBeforeLeave(accountId).then(saved => { if (saved && currentAccountRef.current === accountId) setView(nextView); })
        .finally(() => { relationshipExitInFlight.current = false; });
      return;
    }
    if (view !== "relations" || !window.tongpin?.relationshipGraph) {
      setView(nextView);
      return;
    }

    relationshipExitInFlight.current = true;
    void window.tongpin.relationshipGraph
      .flushCurrent()
      .then((flushed) => {
        if (flushed) setView(nextView);
      })
      .catch(() => undefined)
      .finally(() => {
        relationshipExitInFlight.current = false;
      });
  }, [view, session]);

  useEffect(() => {
    if (!session) return;
    if (roleAllowsAppView(session.user.role, view)) return;
    setView(session.user.role === "admin" ? "admin" : "home");
  }, [session, view]);

  useEffect(() => {
    const root = document.documentElement;
    if (session && !loading && !startupError) root.dataset.appView = view;
    else delete root.dataset.appView;
    return () => {
      delete root.dataset.appView;
    };
  }, [loading, session, startupError, view]);

  useEffect(() => {
    if (!session || session.user.role === "admin") return;
    setHomeLayout(readHomeLayout(session.user.id));
  }, [session?.user.id, session?.user.role]);

  useEffect(() => {
    const root = document.documentElement;
    if (
      session &&
      !loading &&
      !startupError &&
      view === "home" &&
      session.user.role !== "admin"
    ) {
      root.dataset.homeLayout = homeLayout;
    } else {
      delete root.dataset.homeLayout;
    }
    return () => {
      delete root.dataset.homeLayout;
    };
  }, [homeLayout, loading, session, startupError, view]);

  function changeHomeLayout(layout: HomeLayout) {
    setHomeLayout(layout);
    if (session && session.user.role !== "admin") {
      saveHomeLayout(session.user.id, layout);
    }
  }

  let content;

  if (loading) {
    content = (
      <div className="app-loader" role="status" aria-label="正在恢复登录状态">
        <div className="loader-orbit">
          <span />
          <span />
        </div>
        <b>同频</b>
        <small>正在恢复你的工作现场…</small>
      </div>
    );
  } else if (startupError) {
    content = (
      <main className="connectivity-page">
        <section className="connectivity-card" role="alert">
          <span className="connectivity-card__icon" aria-hidden="true">
            <WifiOff size={30} />
          </span>
          <h1>连接不上服务器</h1>
          <p>{startupError}</p>
          <div>
            <button
              className="primary-button"
              type="button"
              onClick={() => void retryStartup()}
            >
              <RefreshCw size={18} />
              重新连接
            </button>
            {session && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void logout()}
              >
                <LogOut size={18} />
                退出登录
              </button>
            )}
          </div>
        </section>
      </main>
    );
  } else if (!session) {
    content = <AuthPage />;
  } else {
    content =
    view === "lora-chain" && canAccessLoraDashboard(session.user.role) ? (
      <LoraChainDashboard />
    ) : view === "relations" && session.user.role === "member" ? (
      <RelationshipMapErrorBoundary
        resetKey={session.user.id}
        onReturn={() => changeView("home")}
      >
        <Suspense fallback={<div className="relationship-map-loading">正在打开…</div>}>
          <RelationshipMapPage userId={session.user.id} />
        </Suspense>
      </RelationshipMapErrorBoundary>
    ) : view === "ai" && (session.user.role === "member" || session.user.role === "boss") ? (
      <Suspense fallback={<div className="tp-ai-page-loading">正在打开同频 AI…</div>}>
        <TongpinAIPage user={session.user} />
      </Suspense>
    ) : view === "admin-ai" && session.user.role === "admin" ? (
      <Suspense fallback={<div className="tp-ai-quota-loading">正在打开 AI 管理…</div>}>
        <AdminAiQuotaPanel />
      </Suspense>
    ) : session.user.role === "admin" ? (
      <AdminConsole />
    ) : view === "boss" && session.user.role === "boss" ? (
      <BossDashboard />
    ) : (
      <MemberHome layout={homeLayout} />
    );
  }

  return (
    <>
      <QuickTaskBridge />
      <CustomCursor />
      <DesktopTitlebar
        hideBrandMark={view === "ai"}
        centerLabel={
          session && !loading && !startupError
            ? view === "relations"
              ? "客户脉络图"
              : view === "ai"
                ? "同频 AI"
                : view === "admin-ai"
                  ? "AI 管理"
              : view === "home" && isLaneHomeLayout(homeLayout)
                ? "今日待办"
                : undefined
            : undefined
        }
      />
      {session && !loading && !startupError ? (
        <AppShell
          view={view}
          onViewChange={changeView}
          homeLayout={homeLayout}
          onHomeLayoutChange={changeHomeLayout}
        >
          {content}
        </AppShell>
      ) : (
        content
      )}
    </>
  );
}
