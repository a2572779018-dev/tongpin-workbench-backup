import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

const page = readSource(
  new URL("../pages/RelationshipMapPage.tsx", import.meta.url),
);
const app = readSource(new URL("../App.tsx", import.meta.url));
const viteConfig = readSource(new URL("../../vite.config.ts", import.meta.url));
const preview = readSource(
  new URL("../features/relationship-map/preview.tsx", import.meta.url),
);
const relationshipStyles = readSource(
  new URL("../features/relationship-map/relationship-map.css", import.meta.url),
);
const appStyles = readSource(new URL("../styles.css", import.meta.url));
const preload = readSource(new URL("../../electron/preload.cjs", import.meta.url));
const electronMain = readSource(new URL("../../electron/main.cjs", import.meta.url));
const authContext = readSource(new URL("../auth/AuthContext.tsx", import.meta.url));
const relationshipApp = readSource(
  new URL(
    "../features/relationship-map/RelationshipMapApp.jsx",
    import.meta.url,
  ),
);
const personModal = readSource(
  new URL("../features/relationship-map/components/PersonModal.jsx", import.meta.url),
);
const personNode = readSource(
  new URL("../features/relationship-map/components/PersonNode.jsx", import.meta.url),
);
const customerTreeEdge = readSource(
  new URL("../features/relationship-map/components/CustomerTreeEdge.jsx", import.meta.url),
);
const tongpinTheme = readSource(
  new URL("../features/relationship-map/tongpin-theme.css", import.meta.url),
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

  it("presents the feature as a collaborated-customer map without legacy analysis controls", () => {
    expect(relationshipApp).toContain("客户脉络图");
    expect(relationshipApp).toContain("已合作客户");
    expect(relationshipApp).not.toContain("生成关系报告");
    expect(relationshipApp).not.toContain("关系层级筛选");
    expect(relationshipApp).not.toContain('className="data-button relation-add-button"');
  });

  it("creates a customer from a node and lets the user choose the existing parent", () => {
    expect(personNode).toContain("data.onAddPerson?.(data.id)");
    expect(personNode).toContain("在此新增客户");
    expect(personModal).toContain("连接到");
    expect(personModal).toContain("暂不连接");
    expect(personModal).toContain("手机号");
    expect(personModal).toContain("微信号");
    expect(personModal).toContain("合作状态");
    expect(personModal).toContain("CUSTOMER_COOPERATION_OPTIONS");
    expect(relationshipApp).toContain('relationship: "客户引荐"');
  });

  it("maps collaborated and pending customer states to solid and dashed lines in real time", () => {
    expect(relationshipApp).toContain("已合作客户");
    expect(relationshipApp).toContain("待合作客户");
    expect(relationshipApp).toContain("isPendingCustomer ? \"7 8\" : undefined");
    expect(relationshipApp).toContain("peopleById.get(customerId)?.cooperationStatus");
    expect(customerTreeEdge).toContain("CUSTOMER_COOPERATION_STATUS.PENDING");
    expect(customerTreeEdge).toContain("const trunkStyle = { ...style, strokeDasharray: undefined }");
    expect(personModal).toContain('id="person-cooperation-status"');
  });

  it("supports horizontal and pyramid layouts with depth colors only in the Tongpin skin", () => {
    expect(relationshipApp).toContain('layout === "horizontal"');
    expect(relationshipApp).toContain('layout === "pyramid"');
    expect(personNode).toContain("person-node--depth-");
    expect(tongpinTheme).toContain(".relationship-theme--tongpin .person-node--depth-1");
    expect(relationshipStyles).not.toContain(".person-node--depth-1 .person-avatar");
  });

  it("routes tree branches from a shared center-side trunk and hides expanded counts", () => {
    expect(relationshipApp).toContain('type: kind === "primary" ? "customerTree"');
    expect(relationshipApp).toContain('? "source-right"');
    expect(relationshipApp).toContain('? "source-bottom"');
    expect(customerTreeEdge).toContain('layout === "pyramid"');
    expect(customerTreeEdge).toContain("const branchY");
    expect(customerTreeEdge).toContain("trunkPath");
    expect(customerTreeEdge).toContain("customerPath");
    expect(personNode).toContain('!data.isExpanded ? <span>{data.hiddenDescendantCount}</span> : null');
  });

  it("locks uploaded avatars to a square crop before applying the circle mask", () => {
    expect(relationshipStyles).toContain("--person-avatar-size: 52px");
    expect(relationshipStyles).toContain("aspect-ratio: 1 / 1");
    expect(relationshipStyles).toContain("flex: 0 0 var(--person-avatar-size)");
    expect(relationshipStyles).toContain("object-fit: cover");
  });

  it("removes the offset shadow only when a real uploaded avatar is visible", () => {
    expect(personNode).toContain('hasVisibleAvatar ? " person-avatar--photo" : ""');
    expect(relationshipStyles).toContain(".person-avatar.person-avatar--photo");
    expect(tongpinTheme).toContain(".person-avatar.person-avatar--photo");
    expect(tongpinTheme).toContain("box-shadow: none");
  });

  it("asks before replacing an existing primary customer connection", () => {
    expect(relationshipApp).toContain("setPendingRelink");
    expect(relationshipApp).toContain("原有主连接会取消");
    expect(relationshipApp).toContain('confirmLabel="确认调整"');
  });
});
