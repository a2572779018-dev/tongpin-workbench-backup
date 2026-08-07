import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/space-grotesk";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NoticeCenterProvider } from "./components/NoticeCenter";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <NoticeCenterProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </NoticeCenterProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
