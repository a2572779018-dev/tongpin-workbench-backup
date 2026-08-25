import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../pages/RelationshipMapPage.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const viteConfig = readFileSync(
  new URL("../../vite.config.ts", import.meta.url),
  "utf8",
);
const preview = readFileSync(
  new URL("../features/relationship-map/preview.tsx", import.meta.url),
  "utf8",
);
const relationshipStyles = readFileSync(
  new URL("../features/relationship-map/relationship-map.css", import.meta.url),
  "utf8",
);
const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const preload = readFileSync(
  new URL("../../electron/preload.cjs", import.meta.url),
  "utf8",
);
const electronMain = readFileSync(
  new URL("../../electron/main.cjs", import.meta.url),
  "utf8",
);
const authContext = readFileSync(
  new URL("../auth/AuthContext.tsx", import.meta.url),
  "utf8",
);
const relationshipApp = readFileSync(
  new URL(
    "../features/relationship-map/RelationshipMapApp.jsx",
    import.meta.url,
  ),
  "utf8",
);

describe("relationship map integration boundary", () => {
  it("mounts inside an isolated shadow root instead of a same-origin iframe", () => {
    expect(page).toContain("attachShadow");
    expect(page).not.toContain("<iframe");
    expect(page).not.toContain("URLSearchParams");
  });

  it("uses the authenticated user id and lazy-loads the feature", () => {
    expect(app).toContain('view === "relations" && session.user.role === "member"');
    expect(app).toContain("userId={session.user.id}");
    expect(app).toContain('lazy(async () =>');
  });

  it("does not publish the preview-only relationship html as a production entry", () => {
    expect(viteConfig).not.toContain("relationship.html");
    expect(preview).not.toContain("URLSearchParams");
    expect(preview).toContain('userId="preview-member"');
    expect(preview).toContain("previewMode");
  });

  it("keeps production graph data out of renderer localStorage", () => {
    expect(page).toContain("window.tongpin?.relationshipGraph");
    expect(page).toContain("allowLocalStorage={previewMode}");
    expect(preload).toContain('ipcRenderer.invoke("relationship-graph:open")');
    expect(preload).not.toContain("relationshipGraph: {\n    loadByUserId");
    expect(electronMain).toContain("verifyCurrentRelationshipMember");
    const memberRoleCheck = electronMain.indexOf(
      'if (current.role !== "member")',
    );
    expect(memberRoleCheck).toBeGreaterThan(-1);
    expect(memberRoleCheck).toBeLessThan(
      electronMain.indexOf("const controller = new AbortController()"),
    );
    expect(electronMain).toContain("assertMainRendererEvent(event)");
    expect(electronMain).not.toContain('ipcMain.handle("relationship-graph:list"');
  });

  it("flushes encrypted graph changes before navigation, logout, close, and update install", () => {
    expect(app).toContain("relationshipExitInFlight");
    expect(app).toMatch(/relationshipGraph\s*\.\s*flushCurrent\(\)/);
    expect(app).toContain("if (flushed) setView(nextView)");
    expect(authContext.indexOf("await persistSession(next)")).toBeLessThan(
      authContext.indexOf("setSessionState(next)"),
    );
    expect(authContext).toContain("await window.tongpin.relationshipGraph.flushCurrent()");
    expect(relationshipApp).toContain("secureStorage.onFlushRequest");
    expect(relationshipApp).toContain("persistTailRef.current");
    expect(electronMain).toContain('mainWindow.on("close", (event) =>');
    expect(electronMain).toContain("requestRelationshipRendererFlush()");
    expect(electronMain).toContain('autoUpdater.on("before-quit-for-update"');
    expect(electronMain).toContain('ipcMain.handle("updater:install", async');
    expect(electronMain).toContain(
      "function handleUpdaterInstallError() {\n  updateInstallInProgress = false;\n  relationshipQuitIntent = false;\n  relationshipWindowCloseApproved = false;",
    );
  });

  it("keeps Tongpin notices above relationship dialogs", () => {
    expect(relationshipStyles).toContain("z-index: var(--layer-modal, 40)");
    expect(appStyles).toContain("--layer-modal: 40");
    expect(appStyles).toContain("--layer-notice: 50");
    expect(appStyles).toContain("--layer-critical: 60");
  });
});
