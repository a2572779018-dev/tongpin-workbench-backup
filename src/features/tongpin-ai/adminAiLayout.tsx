import { AI_BUSINESS_TIERS, AI_BUSINESS_TIER_LABELS, type AiHarnessCapability, type AiHarnessConfig, type AiMember, type AiMode } from "../../../shared/ai";
import type { AiAdminVideoReconciliationJob } from "../../../shared/aiVideo";
import { videoModel } from "../../../shared/aiVideoModels";

/** AI 管理 sections, in the order of the side navigation. */
export type AdminAiSection = "models" | "media" | "tools" | "voice" | "memory" | "computer" | "members" | "monitoring";

export interface AdminAiSectionInfo {
  key: AdminAiSection;
  label: string;
  group: "设置" | "成员" | "运行";
  /** One plain-language line shown above the section. */
  intro: string;
}

export const ADMIN_AI_SECTIONS: readonly AdminAiSectionInfo[] = [
  { key: "models", label: "服务与模型", group: "设置", intro: "先接入 AI 服务（API 密钥填在「服务连接」里），再为快速、标准、深度、Pro 四个档位选择文字、图片、视频模型和开放的能力。" },
  { key: "media", label: "图片与视频", group: "设置", intro: "生成图片、视频按次折算同频点：这里设置价格、是否开放视频和需要人工核对的视频任务。用哪个模型在「服务与模型」的档位里选。" },
  { key: "tools", label: "联网与代码", group: "设置", intro: "联网搜索和代码执行由服务商执行、每次另外折算同频点；只有勾选了这些能力、使用 Responses 协议的档位才会用到。" },
  { key: "voice", label: "语音", group: "设置", intro: "成员说话转文字、朗读回复和语音通话：可以接入硅基流动 CosyVoice2 等自然音色，并决定成员能选哪些音色。" },
  { key: "memory", label: "记忆", group: "设置", intro: "开启后，同频 AI 会记住对成员长期有用的信息，越用越懂成员；只有成员本人能查看和修改。" },
  { key: "computer", label: "电脑操作", group: "设置", intro: "成员让 AI 操作电脑时，每一步由 Jev 决策服务从界面上可做的动作里挑选；这里填 TypeSafe 密钥，设置折算和安全上限。" },
  { key: "members", label: "成员额度", group: "成员", intro: "查看每位成员的同频点额度和用量，并设置或追加额度。" },
  { key: "monitoring", label: "运行监控", group: "运行", intro: "只读查看最近 60 分钟 AI 请求是否正常（成功率、响应速度、告警），不会修改任何配置。" },
];

export function adminAiSection(key: AdminAiSection): AdminAiSectionInfo {
  return ADMIN_AI_SECTIONS.find(section => section.key === key)!;
}

/** True once the administrator has saved the four-tier configuration. A
 * `migratedFromLegacy` config is only a read-only draft of the old settings. */
export function tiersManageRouting(config: AiHarnessConfig | null | undefined): config is AiHarnessConfig {
  return Boolean(config && !config.migratedFromLegacy);
}

/** Admin-visible service name for an internal provider ID (e.g. "legacy-video" → "视频服务"). */
export function harnessProviderLabel(config: AiHarnessConfig | null | undefined, providerId: string): string {
  const name = config?.providers.find(provider => provider.id === providerId)?.name.trim();
  return name || providerId;
}

/** Labels of the enabled tiers that open a capability, in tier order. */
export function tiersWithCapability(config: AiHarnessConfig | null | undefined, capability: AiHarnessCapability, protocol?: "responses"): string[] {
  if (!tiersManageRouting(config)) return [];
  return AI_BUSINESS_TIERS.filter(tier => {
    const route = config.tiers[tier];
    return route.enabled && route.capabilities.includes(capability) && (!protocol || route.protocol === protocol);
  }).map(tier => AI_BUSINESS_TIER_LABELS[tier]);
}

export interface TierVideoRoute { tier: AiMode; tierLabel: string; enabled: boolean; opensVideo: boolean; modelId?: string; modelLabel?: string; providerName?: string }

export function tierVideoRoutes(config: AiHarnessConfig): TierVideoRoute[] {
  return AI_BUSINESS_TIERS.map(tier => {
    const route = config.tiers[tier];
    const configured = Boolean(route.videoProviderId && route.videoModelId);
    return {
      tier, tierLabel: AI_BUSINESS_TIER_LABELS[tier], enabled: route.enabled, opensVideo: route.capabilities.includes("video"),
      ...(configured ? {
        modelId: route.videoModelId!,
        modelLabel: videoModel(route.videoModelId!)?.label ?? route.videoModelId!,
        providerName: harnessProviderLabel(config, route.videoProviderId!),
      } : {}),
    };
  });
}

export const shortTaskId = (id: string) => id.length > 8 ? id.slice(0, 8) : id;

export function AdminAiSectionIntro({ section }: { section: AdminAiSection }) {
  return <p className="tp-ai-admin-tab-intro">{adminAiSection(section).intro}</p>;
}

/** Which video model each tier really uses (set in 服务与模型 → 四个档位). */
export function AdminAiTierVideoNote({ config }: { config: AiHarnessConfig }) {
  const routes = tierVideoRoutes(config);
  return <div className="tp-ai-admin-tier-video-note is-wide">
    <p className="tp-ai-admin-hint">各档位生成视频使用的模型（在「服务与模型」→ 四个档位中修改）：</p>
    <ul>{routes.map(route => <li key={route.tier}>
      <strong>{route.tierLabel}</strong>：{!route.enabled ? "档位已停用" : !route.opensVideo ? "未开放生成视频" : route.modelId
        ? <>{route.modelLabel}<small>（{route.modelId} · {route.providerName}）</small></>
        : "开放了生成视频，但还没选视频模型"}
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
