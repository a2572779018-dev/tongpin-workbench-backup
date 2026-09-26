import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiHarnessConfig, AiHarnessTierRoute } from "../../../shared/ai";
import {
  ADMIN_AI_TAB_INTROS, AdminAiPendingVideoJobSummary, AdminAiTabIntro, AdminAiTierVideoNote,
  everyTierHasVideoModel, harnessProviderLabel, LEGACY_GROUP_LABEL, shortTaskId, tiersManageRouting, tierVideoRoutes,
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

  it("hides the legacy default video model only when every tier has its own video model", () => {
    expect(everyTierHasVideoModel(config())).toBe(true);
    expect(everyTierHasVideoModel(config({ pro: route({ videoProviderId: undefined, videoModelId: undefined }) }))).toBe(false);
    expect(everyTierHasVideoModel(config({}, true))).toBe(false);
    expect(everyTierHasVideoModel(null)).toBe(false);
    const routes = tierVideoRoutes(config({ deep: route({ videoModelId: undefined }) }));
    expect(routes.find(item => item.tier === "quick")).toMatchObject({ modelId: "minimax_h3_内置提示词优化", providerName: "视频服务" });
    expect(routes.find(item => item.tier === "deep")?.modelId).toBeUndefined();
  });

  it("states which video model each tier actually uses", () => {
    const markup = renderToStaticMarkup(createElement(AdminAiTierVideoNote, { config: config({ pro: route({ videoProviderId: undefined, videoModelId: undefined }) }) }));
    expect(markup).toContain("minimax_h3_内置提示词优化 · 视频服务");
    expect(markup).toContain("未设置，使用旧版默认模型");
    expect(markup).not.toContain("旧版默认模型不再生效");
    expect(renderToStaticMarkup(createElement(AdminAiTierVideoNote, { config: config() }))).toContain("旧版默认模型不再生效");
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

  it("explains every tab in one plain line", () => {
    for (const section of ["models", "capabilities", "members", "monitoring"] as const) {
      expect(ADMIN_AI_TAB_INTROS[section]).toMatch(/^这里/);
      expect(renderToStaticMarkup(createElement(AdminAiTabIntro, { section }))).toContain('class="tp-ai-admin-tab-intro"');
    }
  });

  it("keeps legacy settings editable and groups them only when tiers take over", () => {
    const video = readFileSync(new URL("./AdminAiVideoSettings.tsx", import.meta.url), "utf8");
    const provider = readFileSync(new URL("./AdminAiProviderSettings.tsx", import.meta.url), "utf8");
    expect(LEGACY_GROUP_LABEL).toBe("旧版兼容（四档已接管，通常无需修改）");
    expect(video).toContain("{tiersActive ? null : <details className=\"tp-ai-provider-capabilities is-wide\"><summary>旧版视频接入</summary>");
    expect(video).toContain("{hideLegacyDefault ? null :");
    expect(provider).toContain("{tiersActive ? null : legacyConnection}");
    expect(provider).toContain("{tiersActive ? null : legacyImage}");
    expect(provider).toContain("{LEGACY_GROUP_LABEL} · 文字与图片");
    const observability = readFileSync(new URL("./AdminAiObservability.tsx", import.meta.url), "utf8");
    expect(observability).toContain("harnessProviderLabel(harnessConfig, slice.provider)");
  });
});
