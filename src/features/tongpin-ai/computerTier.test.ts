import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computerTierNotice } from "./computerTier";

describe("@computer tier check (#9)", () => {
  it("blocks early with the tiers that do allow it", () => {
    expect(computerTierNotice(["pro"], "deep")).toBe("当前「深度」档位未开放电脑操作，请切换到「Pro」后再试。");
    expect(computerTierNotice(["standard", "pro"], "quick")).toContain("「标准」或「Pro」");
    expect(computerTierNotice([], "deep")).toContain("目前没有档位开启此能力");
  });
  it("lets the server decide when the tier list is unknown or allows it", () => {
    expect(computerTierNotice(undefined, "deep")).toBeNull();
    expect(computerTierNotice(["deep"], "deep")).toBeNull();
  });
  it("runs before the computer-use session starts", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    const start = page.indexOf("function beginComputerUse");
    const check = page.indexOf("computerTierNotice(aiStatus?.computerTiers, mode)", start);
    const session = page.indexOf("const conversationId = existingConversationId", start);
    expect(check).toBeGreaterThan(start);
    expect(check).toBeLessThan(session);
  });
});
