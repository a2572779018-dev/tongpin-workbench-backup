import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NoticeCenterProvider } from "./components/NoticeCenter";
import { QuickCorner } from "./components/QuickCorner";
import { QuickTaskPanel } from "./components/QuickTaskPanel";
import "./styles.css";
import "./quick-task.css";

const surface = new URLSearchParams(window.location.search).get("surface");
if (surface === "quick-corner" || surface === "quick-panel") {
  document.documentElement.dataset.surface = surface;
}

const content =
  surface === "quick-corner" ? (
    <QuickCorner />
  ) : surface === "quick-panel" ? (
    <QuickTaskPanel />
  ) : (
    <AppErrorBoundary>
      <NoticeCenterProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </NoticeCenterProvider>
    </AppErrorBoundary>
  );

createRoot(document.getElementById("root")!).render(
  <StrictMode>{content}</StrictMode>,
);
