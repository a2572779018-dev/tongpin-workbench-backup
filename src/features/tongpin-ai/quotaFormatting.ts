import type { AiQuota } from "../../../shared/ai";

export const AI_QUOTA_UNIT = "同频点";
export const AI_QUOTA_BILLING_NOTE = "文本每 1 Token 计 1 同频点；图片与联网搜索按管理员设置折算为同频点。";

/** Display only: no conversion, quota mutation, or ledger rewriting. */
export const formatAiPoints = (value: number) => `${value.toLocaleString("zh-CN")} ${AI_QUOTA_UNIT}`;

export function quotaPercent(value: number, limit: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(limit) || value < 0 || limit < 0) return null;
  if (limit === 0) return 0;
  return Math.min(100, value / limit * 100);
}

export function formatQuotaPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  if (percent < 100 && percent > 99.9) return ">99.9%";
  return `${Math.round(percent * 10) / 10}%`;
}

export function quotaRemainingSummary(quota: Pick<AiQuota, "limitTokens" | "remainingTokens" | "reservedTokens">, synced = true) {
  // remainingTokens is already net of reservations in the server response.
  const percent = synced ? quotaPercent(quota.remainingTokens, quota.limitTokens) : null;
  if (percent === null) return { percent, label: "尚未同步", note: "" };
  const note = quota.limitTokens === 0 ? "尚未分配，请联系管理员"
    : quota.reservedTokens > 0 ? "已扣除处理中预留，结算后更新"
    : percent === 0 ? "已耗尽，请联系管理员追加"
    : "";
  return { percent, label: `剩余 ${formatQuotaPercent(percent)}`, note };
}
