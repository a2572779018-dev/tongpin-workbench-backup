import { AI_BUSINESS_TIERS, AI_BUSINESS_TIER_LABELS, type AiHarnessConfig, type AiMember, type AiMode } from "../../../shared/ai";
import type { AiAdminVideoReconciliationJob } from "../../../shared/aiVideo";
import { videoModel } from "../../../shared/aiVideoModels";

export type AdminAiSection = "models" | "capabilities" | "members" | "monitoring";

/** One plain-language line per admin tab, shown above the tab content. */
export const ADMIN_AI_TAB_INTROS: Record<AdminAiSection, string> = {
  models: "这里决定成员实际用哪个 AI：先接入服务，再为快速、标准、深度、Pro 四个档位分别选择文字、图片、视频模型。",
  capabilities: "这里控制图片、画面理解、联网搜索和视频是否开放，以及每次使用折算多少同频点；具体用哪个模型在「服务与模型」中选择。",
  members: "这里查看每位成员的同频点额度和用量，并为成员设置或追加额度。",
  monitoring: "这里只读查看最近 60 分钟 AI 请求是否正常（成功率、响应速度、告警），不会修改任何配置。",
};

export const LEGACY_GROUP_LABEL = "旧版兼容（四档已接管，通常无需修改）";

/** True once the administrator has saved the four-tier configuration. A
 * `migratedFromLegacy` config is only a read-only draft of the old settings,
 * so the legacy fields still drive routing in that case. */
export function tiersManageRouting(config: AiHarnessConfig | null | undefined): config is AiHarnessConfig {
  return Boolean(config && !config.migratedFromLegacy);
}

/** Admin-visible service name for an internal provider ID (e.g. "legacy-video" → "视频服务"). */
export function harnessProviderLabel(config: AiHarnessConfig | null | undefined, providerId: string): string {
  const name = config?.providers.find(provider => provider.id === providerId)?.name.trim();
  return name || providerId;
}

export interface TierVideoRoute { tier: AiMode; tierLabel: string; enabled: boolean; modelId?: string; modelLabel?: string; providerName?: string }

export function tierVideoRoutes(config: AiHarnessConfig): TierVideoRoute[] {
  return AI_BUSINESS_TIERS.map(tier => {
    const route = config.tiers[tier];
    const configured = Boolean(route.videoProviderId && route.videoModelId);
    return {
      tier, tierLabel: AI_BUSINESS_TIER_LABELS[tier], enabled: route.enabled,
      ...(configured ? {
        modelId: route.videoModelId!,
        modelLabel: videoModel(route.videoModelId!)?.label ?? route.videoModelId!,
        providerName: harnessProviderLabel(config, route.videoProviderId!),
      } : {}),
    };
  });
}

/** When every tier names its own video model, the legacy default model is never used. */
export function everyTierHasVideoModel(config: AiHarnessConfig | null | undefined): boolean {
  return tiersManageRouting(config) && tierVideoRoutes(config).every(route => Boolean(route.modelId));
}

export const shortTaskId = (id: string) => id.length > 8 ? id.slice(0, 8) : id;

export function AdminAiTabIntro({ section }: { section: AdminAiSection }) {
  return <p className="tp-ai-admin-tab-intro">{ADMIN_AI_TAB_INTROS[section]}</p>;
}

export function AdminAiTierVideoNote({ config }: { config: AiHarnessConfig }) {
  const routes = tierVideoRoutes(config);
  const allConfigured = routes.every(route => Boolean(route.modelId));
  return <div className="tp-ai-admin-tier-video-note is-wide">
    <p className="tp-ai-admin-hint">{allConfigured
      ? "四个档位都已在「服务与模型」中设置视频模型，成员实际使用下列模型，旧版默认模型不再生效："
      : "成员实际使用的视频模型（在「服务与模型」→ 四个档位中设置）；未设置视频模型的档位才会使用下方旧版默认模型："}</p>
    <ul>{routes.map(route => <li key={route.tier}>
      <strong>{route.tierLabel}</strong>：{route.modelId
        ? <>{route.modelLabel}<small>（{route.modelId} · {route.providerName}）</small></>
        : "未设置，使用旧版默认模型"}{route.enabled ? "" : "（档位已停用）"}
    </li>)}</ul>
  </div>;
}

export function AdminAiPendingVideoJobSummary({ job, member }: {
  job: Pick<AiAdminVideoReconciliationJob, "id" | "userId" | "createdAt" | "providerTaskId" | "quotaPoints">;
  member?: Pick<AiMember, "name" | "email">;
}) {
  const created = new Date(job.createdAt);
  return <>
    <header><strong>{member ? member.name : "未知成员"}</strong>
      <small>{member ? member.email : `成员编号 ${shortTaskId(job.userId)}`}</small></header>
    <p>创建于 <time dateTime={job.createdAt}>{Number.isNaN(created.getTime()) ? job.createdAt : created.toLocaleString("zh-CN")}</time>
      {" · "}任务 <code title={job.id}>{shortTaskId(job.id)}</code>{" · "}预留 {job.quotaPoints} 同频点</p>
    {job.providerTaskId ? <p>服务商任务编号：<code>{job.providerTaskId}</code></p> : null}
  </>;
}
