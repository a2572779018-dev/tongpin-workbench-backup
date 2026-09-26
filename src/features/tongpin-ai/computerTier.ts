import { AI_BUSINESS_TIER_LABELS, type AiMode } from "../../../shared/ai";

/**
 * @computer is a tier capability. Tell the member up front (before any macOS
 * permission check, session or window snapshot) when the current tier does
 * not allow it, and which tier does. `undefined` = older server or a legacy
 * no-tier setup: the server stays authoritative, so nothing is blocked here.
 */
export function computerTierNotice(computerTiers: readonly AiMode[] | undefined, mode: string): string | null {
  if (!computerTiers || computerTiers.includes(mode as AiMode)) return null;
  const current = AI_BUSINESS_TIER_LABELS[mode as AiMode] ?? mode;
  if (!computerTiers.length) return `当前「${current}」档位未开放电脑操作；目前没有档位开启此能力，请联系管理员在「AI 管理 → 服务与模型」为某个档位勾选“电脑操作”。`;
  return `当前「${current}」档位未开放电脑操作，请切换到「${computerTiers.map(tier => AI_BUSINESS_TIER_LABELS[tier]).join("」或「")}」后再试。`;
}
