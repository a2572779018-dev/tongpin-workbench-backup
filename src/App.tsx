import { useEffect, useState } from "react";
import { LogOut, RefreshCw, WifiOff } from "lucide-react";
import { useAuth } from "./auth/AuthContext";
import { AppShell, type AppView } from "./components/AppShell";
import { CustomCursor } from "./components/CustomCursor";
import { DesktopTitlebar } from "./components/DesktopTitlebar";
import { AdminConsole } from "./pages/AdminConsole";
import { AuthPage } from "./pages/AuthPage";
import { BossDashboard } from "./pages/BossDashboard";
import { MemberHome } from "./pages/MemberHome";
import {
  isLaneHomeLayout,
  readHomeLayout,
  saveHomeLayout,
  type HomeLayout,
} from "./lib/homeLayout";

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

  useEffect(() => {
    if (!session) return;
    if (session.user.role === "admin") {
      setView("admin");
    } else if (view === "admin" || (view === "boss" && session.user.role !== "boss")) {
      setView("home");
    }
  }, [session, view]);

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
    session.user.role === "admin" ? (
      <AdminConsole />
    ) : view === "boss" && session.user.role === "boss" ? (
      <BossDashboard />
    ) : (
      <MemberHome layout={homeLayout} />
    );
  }

  return (
    <>
      <CustomCursor />
      <DesktopTitlebar
        centerLabel={
          session &&
          !loading &&
          !startupError &&
          view === "home" &&
          isLaneHomeLayout(homeLayout)
            ? "今日待办"
            : undefined
        }
      />
      {session && !loading && !startupError ? (
        <AppShell
          view={view}
          onViewChange={setView}
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
