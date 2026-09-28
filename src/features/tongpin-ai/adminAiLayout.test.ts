import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiHarnessConfig, AiHarnessTierRoute } from "../../../shared/ai";
import {
  ADMIN_AI_SECTIONS, AdminAiPendingVideoJobSummary, AdminAiSectionIntro, AdminAiTierVideoNote,
  harnessProviderLabel, shortTaskId, tiersManageRouting, tiersWithCapability, tierVideoRoutes,
} from "./adminAiLayout";

const route = (patch: Partial<AiHarnessTierRoute> = {}): AiHarnessTierRoute => ({
  providerId: "legacy", modelId: "gpt", protocol: "chat_completions", maxOutputTokens: 2048, reasoningEffort: "",
  capabilities: ["chat", "video"], enabled: true, videoProviderId: "legacy-video", videoModelId: "minimax_h3_内置提示词优化", ...patch,
});
const provider = (id: string, name: string) => ({ id, name, baseUrl: "https://x.test/v1", protocol: "chat_completions" as const, enabled: true, apiKeyConfigured: true, modelsVerified: true, availableModels: [], modelsVerifiedAt: null });
const config = (tiers: Partial<Record<"quick" | "standard" | "deep" | "pro", AiHarnessTierRoute>> = {}, migratedFromLegacy = false): AiHarnessConfig => ({
  providers: [provider("legacy", "同频ai"), provider("legacy-image", "图片服务"), provider("legacy-video", "视频服务")],
  tiers: { quick: route(), standard: route(), deep: route(), pro: route(), ...tiers },
  policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
  updatedAt: "2026-09-26T00:00:00.000Z", migratedFromLegacy,
});

describe("AI admin layout helpers", () => {
  it("maps internal provider IDs to the configured service name and falls back to the ID", () => {
    expect(harnessProviderLabel(config(), "legacy")).toBe("同频ai");
    expect(harnessProviderLabel(config(), "legacy-video")).toBe("视频服务");
    expect(harnessProviderLabel(config(), "unknown-id")).toBe("unknown-id");
    expect(harnessProviderLabel(null, "legacy-image")).toBe("legacy-image");
  });

  it("treats only a saved tier configuration as taking over routing", () => {
    expect(tiersManageRouting(null)).toBe(false);
    expect(tiersManageRouting(config({}, true))).toBe(false);
    expect(tiersManageRouting(config())).toBe(true);
  });

  it("lists which tiers open a capability, and which video model each tier uses", () => {
    const cfg = config({ deep: route({ capabilities: ["chat"], videoModelId: undefined, videoProviderId: undefined }), pro: route({ enabled: false }) });
    expect(tiersWithCapability(cfg, "video")).toEqual(["快速", "标准"]);
    expect(tiersWithCapability(config({}, true), "video")).toEqual([]);
    expect(tiersWithCapability(cfg, "web_search", "responses")).toEqual([]);
    const routes = tierVideoRoutes(cfg);
    expect(routes.find(item => item.tier === "quick")).toMatchObject({ modelId: "minimax_h3_内置提示词优化", providerName: "视频服务", opensVideo: true });
    expect(routes.find(item => item.tier === "deep")).toMatchObject({ opensVideo: false });
    const markup = renderToStaticMarkup(createElement(AdminAiTierVideoNote, { config: cfg }));
    expect(markup).toContain("minimax_h3_内置提示词优化 · 视频服务");
    expect(markup).toContain("<strong>深度</strong>：未开放生成视频");
    expect(markup).toContain("<strong>Pro</strong>：档位已停用");
    expect(markup).not.toContain("旧版");
    expect(renderToStaticMarkup(createElement(AdminAiTierVideoNote, { config: config({ standard: route({ videoModelId: undefined }) }) }))).toContain("还没选视频模型");
  });

  it("shows member identity, creation time and a short task ID for pending video jobs", () => {
    const job = { id: "0f3c9a7e-1111-2222-3333-444455556666", userId: "u-7a1b2c3d-9999", createdAt: "2026-09-26T03:04:05.000Z", quotaPoints: 50, providerTaskId: "prov-1" };
    const named = renderToStaticMarkup(createElement(AdminAiPendingVideoJobSummary, { job, member: { name: "张三", email: "zs@example.test" } }));
    expect(named).toContain("<strong>张三</strong>");
    expect(named).toContain("zs@example.test");
    expect(named).toContain(`title="${job.id}">0f3c9a7e</code>`);
    expect(named).toContain('dateTime="2026-09-26T03:04:05.000Z"');
    expect(named).not.toContain(job.userId);
    const unknown = renderToStaticMarkup(createElement(AdminAiPendingVideoJobSummary, { job }));
    expect(unknown).toContain("未知成员");
    expect(unknown).toContain(`成员编号 ${shortTaskId(job.userId)}`);
  });

  it("explains every section in one plain line, grouped in the side navigation", () => {
    expect(ADMIN_AI_SECTIONS.map(section => section.label)).toEqual(["服务与模型", "图片与视频", "联网与代码", "语音", "记忆", "电脑操作", "成员额度", "运行监控"]);
    for (const section of ADMIN_AI_SECTIONS) {
      expect(section.intro.length).toBeGreaterThan(10);
      expect(renderToStaticMarkup(createElement(AdminAiSectionIntro, { section: section.key }))).toContain('class="tp-ai-admin-tab-intro"');
    }
    // The key goes into 服务连接, and the intro says so.
    expect(ADMIN_AI_SECTIONS[0].intro).toContain("API 密钥");
  });

  it("has no legacy connection, legacy image or legacy video settings left", () => {
    const video = readFileSync(new URL("./AdminAiVideoSettings.tsx", import.meta.url), "utf8");
    const capabilities = readFileSync(new URL("./AdminAiCapabilitySettings.tsx", import.meta.url), "utf8");
    const panel = readFileSync(new URL("./AdminAiQuotaPanel.tsx", import.meta.url), "utf8");
    for (const source of [video, capabilities, panel]) expect(source).not.toMatch(/旧版|legacy|AdminAiProviderSettings/i);
    expect(capabilities).toContain('"/api/admin/ai/capabilities"');
    expect(capabilities).not.toMatch(/apiKey|baseUrl|quickModel/);
    const observability = readFileSync(new URL("./AdminAiObservability.tsx", import.meta.url), "utf8");
    expect(observability).toContain("harnessProviderLabel(harnessConfig, slice.provider)");
  });
});

