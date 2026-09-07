import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  expect(startIndex, `missing source boundary: ${start}`).toBeGreaterThan(-1);
  expect(endIndex, `missing source boundary: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

const app = readSource(new URL("../App.tsx", import.meta.url));
const appShell = readSource(
  new URL("../components/AppShell.tsx", import.meta.url),
);
const adminConsole = readSource(
  new URL("../pages/AdminConsole.tsx", import.meta.url),
);
const memberPage = readSource(
  new URL("../pages/TongpinAIPage.tsx", import.meta.url),
);
const chatWorkspace = readSource(
  new URL("../features/tongpin-ai/ChatWorkspace.tsx", import.meta.url),
);
const skillMarketplace = readSource(
  new URL("../features/tongpin-ai/SkillMarketplace.tsx", import.meta.url),
);
const notificationButton = readSource(
  new URL(
    "../features/tongpin-ai/TongpinAINotificationButton.tsx",
    import.meta.url,
  ),
);
const adminQuotaPanel = readSource(
  new URL("../features/tongpin-ai/AdminAiQuotaPanel.tsx", import.meta.url),
);
const mockData = readSource(
  new URL("../features/tongpin-ai/mockData.ts", import.meta.url),
);
const aiSidebar = readSource(
  new URL("../features/tongpin-ai/TongpinAISidebar.tsx", import.meta.url),
);
const projectWorkspace = readSource(
  new URL("../features/tongpin-ai/ProjectWorkspaceEmpty.tsx", import.meta.url),
);
const accountUsage = readSource(
  new URL("../features/tongpin-ai/TongpinAIAccountUsage.tsx", import.meta.url),
);
const expressApp = readSource(new URL("../../server/app.ts", import.meta.url));
const cloudflareCore = readSource(
  new URL("../../cloudflare/src/core.ts", import.meta.url),
);

const featureDirectory = fileURLToPath(
  new URL("../features/tongpin-ai/", import.meta.url),
);
const p0RendererSources: Array<[string, string]> = [
  ["src/pages/TongpinAIPage.tsx", memberPage],
  ...readdirSync(featureDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.includes(".test.") &&
        [".ts", ".tsx"].includes(extname(entry.name)),
    )
    .map(
      (entry): [string, string] => [
        `src/features/tongpin-ai/${entry.name}`,
        readFileSync(join(featureDirectory, entry.name), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      ],
    ),
];

describe("Tongpin AI authenticated integration boundary", () => {
  it("places the member AI entry immediately after the relationship map", () => {
    const navItems = sliceBetween(
      appShell,
      "const navItems = useMemo",
      "async function markRead",
    );
    const homeIndex = navItems.indexOf('view: "home" as const');
    const relationsIndex = navItems.indexOf('view: "relations" as const');
    const aiIndex = navItems.indexOf('view: "ai" as const');
    const bossItemsIndex = navItems.indexOf('...(user.role === "boss"');

    expect(navItems).toContain('if (user.role === "admin")');
    expect(navItems).toContain('...(user.role === "member"');
    expect(homeIndex).toBeGreaterThan(-1);
    expect(relationsIndex).toBeGreaterThan(homeIndex);
    expect(aiIndex).toBeGreaterThan(relationsIndex);
    expect(bossItemsIndex).toBeGreaterThan(aiIndex);
    expect(
      navItems
        .slice(homeIndex, bossItemsIndex)
        .match(/view: "[^"]+" as const/g),
    ).toEqual([
      'view: "home" as const',
      'view: "relations" as const',
      'view: "ai" as const',
    ]);
    expect(navItems.slice(relationsIndex, aiIndex)).toContain(
      'label: "客户脉络图"',
    );
    expect(navItems.slice(aiIndex)).toContain('label: "同频 AI"');
  });

  it("renders member and boss AI while keeping management administrator-only", () => {
    const contentBranch = sliceBetween(
      app,
      "    content =",
      "\n  }\n\n  return (",
    );
    const memberGate = contentBranch.indexOf(
      'view === "ai" && (session.user.role === "member" || session.user.role === "boss")',
    );
    const adminQuotaGate = contentBranch.indexOf(
      'view === "admin-ai" && session.user.role === "admin"',
    );
    const adminFallback = contentBranch.indexOf(
      'session.user.role === "admin" ? (',
      adminQuotaGate + 1,
    );

    expect(memberGate).toBeGreaterThan(-1);
    expect(contentBranch.slice(memberGate)).toMatch(
      /<TongpinAIPage\s+user=\{session\.user\}\s*\/>/,
    );
    expect(adminQuotaGate).toBeGreaterThan(memberGate);
    expect(contentBranch.slice(adminQuotaGate)).toContain(
      "<AdminAiQuotaPanel />",
    );
    expect(adminFallback).toBeGreaterThan(adminQuotaGate);
    expect(contentBranch.slice(adminFallback)).toContain("<AdminConsole />");
  });

  it("keeps the existing admin account console separate and intact", () => {
    expect(adminConsole).toContain('api<{ users: AdminUser[] }>("/api/admin/users")');
    expect(adminConsole).toContain(
      "`/api/admin/users/${user.id}/access`",
    );
    expect(adminConsole).toContain("`/api/admin/users/${user.id}/role`");
    expect(adminConsole).toContain("`/api/admin/users/${user.id}/profile`");
    expect(adminQuotaPanel).not.toContain("AdminConsole");
  });

  it("keeps notifications reachable while the AI workbench owns the viewport", () => {
    expect(appShell).toContain(
      'view !== "relations" && view !== "ai" ? (',
    );
    expect(memberPage).toContain("useNotificationToolbar");
    expect(
      memberPage.match(
        /onOpenNotifications=\{notificationToolbar\?\.openNotificationDrawer\}/g,
      ),
    ).toHaveLength(3);
    expect(chatWorkspace).toContain("<TongpinAINotificationButton");
    expect(skillMarketplace).toContain("<TongpinAINotificationButton");
    expect(projectWorkspace).toContain("<TongpinAINotificationButton");
    expect(notificationButton).toContain(
      'aria-label={`消息中心${unread ? `，${unread} 条未读` : ""}`}',
    );
  });

  it("keeps admin quota and open-source stack comparisons out of the member surface", () => {
    const memberSurface = [
      memberPage,
      aiSidebar,
      chatWorkspace,
      skillMarketplace,
      projectWorkspace,
      accountUsage,
      mockData,
    ].join("\n");

    for (const forbiddenCopy of [
      "管理员额度",
      "管理员配额",
      "开源底座",
      "LibreChat",
      "AnythingLLM",
      "Open WebUI",
      "LobeHub",
      "Dify",
      "MEMBER WORKSPACE",
      "PROJECT CONTAINER",
      "P0 本地项目容器",
      "项目不会被当作一条对话",
      "P0 本地演示",
      "未连接模型",
      "不产生费用",
    ]) {
      expect(memberSurface).not.toContain(forbiddenCopy);
    }

    expect(memberPage).not.toContain("AdminAiQuotaPanel");
    expect(memberSurface).not.toContain("AI CONTROL DESK");
  });

  it("does not let members restore or grant their own AI quota", () => {
    const memberSurface = [memberPage, aiSidebar, accountUsage, chatWorkspace].join("\n");
    for (const forbiddenMemberControl of [
      "onToggleQuota", "onRestoreQuota", "toggleQuota", "恢复演示额度", "模拟额度用尽",
    ]) expect(memberSurface).not.toContain(forbiddenMemberControl);
    expect(chatWorkspace).toContain("联系管理员");
  });

  it("does not seed member conversations or fabricate provider usage", () => {
    expect(memberPage).not.toMatch(/INITIAL_(?:CONVERSATIONS|ARTIFACTS|AI_USAGE)/);
    expect(memberPage).not.toContain("window.setInterval");
    expect(memberPage).toContain("useAuth");
    expect(memberPage).toContain('"/api/ai/chat"');
    expect(memberPage).toContain("response.quota");
    expect(memberPage).not.toContain("submitUnavailableMessage");
    expect(memberPage).toContain("key={user.id}");
  });

  it("keeps provider secrets and quota mutation behind authenticated server routes", () => {
    const forbiddenPatterns: Array<[string, RegExp]> = [
      ["direct provider fetch", /\bfetch\s*\(/],
      ["shared request helper", /\bpublicRequest\b/],
      ["browser persistence", /\b(?:localStorage|sessionStorage)\b/],
      ["Electron bridge", /\bwindow\.tongpin\b/],
      ["runtime secret/config", /\b(?:process\.env|import\.meta\.env)\b/],
    ];

    for (const [file, source] of p0RendererSources) {
      for (const [boundary, pattern] of forbiddenPatterns) {
        // The citation component has one reviewed, URL-only bridge. It does not
        // receive session/provider secrets or change the quota. All other bridge
        // accesses remain forbidden, including new properties in this component.
        const inspected = boundary === "Electron bridge" && file.endsWith("/AiSourceLink.tsx")
          ? source.replace(/\bwindow\.tongpin\.openAiSource\b/g, "reviewedAiSourceOpener")
            .replace(/if \(!window\.tongpin\) return;/g, "")
          : source;
        expect(inspected, `${file} crossed credential boundary: ${boundary}`).not.toMatch(
          pattern,
        );
      }
    }

    expect(expressApp).toMatch(/["'`]\/api\/ai/);
    expect(expressApp).toMatch(/["'`]\/api\/admin\/ai/);
    expect(cloudflareCore).toContain("Ai");
    expect(adminQuotaPanel).not.toContain("MOCK_MEMBERS");
    expect(adminQuotaPanel).not.toContain("MOCK_LEDGER");
    expect(accountUsage).toContain('"/api/ai/usage"');
    expect(accountUsage).not.toContain("每次 12 点");
    expect([memberPage, aiSidebar, accountUsage, chatWorkspace].join("\n")).not.toMatch(/\/api\/admin\/ai/);
  });
});
