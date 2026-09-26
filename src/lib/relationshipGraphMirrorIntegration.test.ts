import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const app = source("src/App.tsx");
const shell = source("src/components/AppShell.tsx");
const page = source("src/pages/RelationshipMapPage.tsx");
const bossPage = source("src/pages/BossRelationshipGraphs.tsx");
const editor = source("src/features/relationship-map/RelationshipMapApp.jsx");
const expressRoutes = source("server/routes/relationship-graphs.ts");
const expressApp = source("server/app.ts");
const workerRoutes = source("cloudflare/src/relationshipGraphs.ts");
const workerCore = source("cloudflare/src/core.ts");
const workerEntry = source("cloudflare/src/index.ts");
const electronMain = source("electron/main.cjs");

describe("客户脉络图 boss mirror wiring", () => {
  it("adds a boss-only navigation entry and page", () => {
    expect(app).toContain('view === "member-graphs" && session.user.role === "boss"');
    expect(app).toContain("<BossRelationshipGraphs />");
    expect(shell).toContain('"member-graphs": "成员客户脉络图"');
    const bossBlock = shell.indexOf('...(user.role === "boss"');
    const entry = shell.indexOf('view: "member-graphs" as const');
    expect(bossBlock).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(bossBlock);
    expect(entry).toBeLessThan(shell.indexOf('view: "lora-chain" as const'));
    // Members keep their own map; the boss never gets the editable one.
    expect(app).toContain('view === "relations" && session.user.role === "member"');
  });

  it("uploads from the member renderer only after a successful encrypted save", () => {
    expect(page).toContain("previewMode ? null : (\n        <RelationshipGraphMirrorBridge");
    expect(page).toContain('"X-Tongpin-Account": userId');
    expect(page).toContain("onSecureGraphSaved={previewMode ? undefined : noteSecureGraphSaved}");
    expect(page).toContain("controller.dispose({ flush: true })");
    const savedStatus = editor.indexOf('setStorageStatus(secureStorage ? "已加密保存到本机" : "已保存到本机")');
    const notify = editor.indexOf("notifySecureGraph(secureGraphSavedRef.current");
    expect(savedStatus).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(savedStatus);
    expect(notify).toBeLessThan(editor.indexOf('setStorageStatus(secureStorage ? "加密保存失败" : "本地保存失败")'));
    expect(editor).toContain("The boss mirror is best effort and must never affect local saving.");
  });

  it("keeps the boss viewer away from any vault, local graph storage or writes", () => {
    const viewer = page.slice(page.indexOf("export function RelationshipMapReadOnlyView"));
    expect(viewer).toContain("readOnlyGraph={graph}");
    expect(viewer).not.toContain("secureStorage");
    expect(viewer).not.toContain("allowLocalStorage");
    expect(viewer).not.toContain("onSecureGraph");
    expect(editor.indexOf("if (readOnly) return undefined;")).toBeLessThan(editor.indexOf("void secureStorage.open()"));
    expect(bossPage).toContain("BOSS_RELATIONSHIP_GRAPHS_PATH");
    for (const write of ['method: "PUT"', 'method: "POST"', 'method: "PATCH"', 'method: "DELETE"', "relationshipGraph.", "localStorage"]) {
      expect(bossPage).not.toContain(write);
    }
  });

  it("reuses the existing Boss-only and member-only guards on both backends", () => {
    expect(expressRoutes).toContain('router.use(noStore, requireAuth, requireRole("member"))');
    expect(expressRoutes).toContain('router.use(noStore, requireAuth, requireRole("boss"))');
    expect(expressApp.indexOf('"/api/boss/relationship-graphs"')).toBeLessThan(expressApp.indexOf('app.use("/api/boss", createBossRouter'));
    expect(expressApp.indexOf('app.use("/api/relationship-graphs"')).toBeLessThan(expressApp.indexOf('app.use(express.json({ limit: "768kb" }))'));
    expect(workerRoutes.match(/requireUser\(request, \["boss"\]\)/g)).toHaveLength(2);
    expect(workerRoutes.match(/requireUser\(request, \["member"\]\)/g)).toHaveLength(2);
    expect(workerCore).toContain("requireUser: (current, roles) => this.requireUser(current, roles)");
    expect(workerEntry).toContain("path === RELATIONSHIP_GRAPH_ME_PATH ? RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES");
    // The local vault stays member-only and unchanged.
    expect(electronMain).toContain('if (current.role !== "member")');
  });

  it("applies migration 7 on both the fresh and the early-exit path", () => {
    expect(workerCore).toContain("'boss_work_report_statuses', 'relationship_graph_snapshots'");
    expect(workerCore).toContain('if (!existingTables.has("relationship_graph_snapshots"))');
    expect(workerCore).toContain("if (currentVersion >= 7) return;");
    expect(workerCore).toContain("if (version < 7) {");
  });
});
