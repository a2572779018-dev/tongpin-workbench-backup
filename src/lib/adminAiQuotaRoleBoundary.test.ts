import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

const app = readSource(new URL("../App.tsx", import.meta.url));
const adminQuotaPanel = readSource(
  new URL("../features/tongpin-ai/AdminAiQuotaPanel.tsx", import.meta.url),
);
const aiTypes = readSource(
  new URL("../features/tongpin-ai/types.ts", import.meta.url),
);

describe("admin AI quota role boundary", () => {
  it("keeps the quota console behind the administrator route guard", () => {
    expect(app).toContain(
      'view === "admin-ai" && session.user.role === "admin"',
    );
  });

  it("models quota recipients as members without a boss role", () => {
    expect(aiTypes).not.toContain("AiQuotaRole");
    expect(aiTypes).not.toMatch(/role:\s*["']?(?:member|boss)/);
    expect(adminQuotaPanel).not.toContain('role: "boss"');
    expect(adminQuotaPanel).not.toContain('value="boss"');
    expect(adminQuotaPanel).not.toContain("member-suran");
    expect(adminQuotaPanel).not.toContain("老板");
  });

  it("does not retain a role filter for the member-only registry", () => {
    expect(adminQuotaPanel).not.toContain("roleFilter");
    expect(adminQuotaPanel).not.toContain("AiQuotaRole");
    expect(adminQuotaPanel).not.toContain("筛选成员角色");
    expect(adminQuotaPanel).toContain('session?.user.role === "admin"');
    expect(adminQuotaPanel).toContain('"/api/admin/ai/members"');
    expect(adminQuotaPanel).toContain("{member.email}");
  });

  it("uses real member and usage records without seeded balances or resets", () => {
    expect(adminQuotaPanel).not.toMatch(/MOCK_MEMBERS|MOCK_LEDGER|monthlyLimit|bonusQuota|模拟重置/);
    expect(adminQuotaPanel).toContain("useState<AiMember[]>([])");
    expect(adminQuotaPanel).toContain("useState<AiUsageEntry[]>([])");
    expect(adminQuotaPanel).toContain("member.quota.reservedTokens");
    expect(adminQuotaPanel).toContain("/api/admin/ai/usage?userId=");
  });
});
