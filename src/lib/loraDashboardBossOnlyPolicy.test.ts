import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("LORA dashboard boss-only policy", () => {
  it("keeps the desktop entry, actions and realtime updates boss-only", () => {
    const access = source("src/lib/loraDashboardAccess.ts");
    const shell = source("src/components/AppShell.tsx");

    expect(access).toContain('return role === "boss";');
    expect(access).toContain(
      'if (role === "admin") return ["admin", "admin-ai"];',
    );
    expect(access).not.toContain('role === "boss" || role === "admin"');
    expect(shell).not.toContain(
      'user.role === "boss" || user.role === "admin"',
    );
  });

  it("rejects non-boss roles in both local and Cloudflare APIs", () => {
    const localRoute = source("server/routes/lora-chain.ts");
    const localCollector = source("server/lora-chain/collector.ts");
    const workerPlatform = source("cloudflare/src/platform.ts");
    const workerCore = source("cloudflare/src/core.ts");

    expect(localRoute).toContain('requireRole("boss")');
    expect(localRoute).not.toContain('requireRole("boss", "admin")');
    expect(localCollector).not.toContain(
      'user.role === "boss" || user.role === "admin"',
    );
    expect(workerPlatform).toContain('return role === "boss";');
    expect(workerCore).not.toContain('user.role === "admin" || trigger');
    expect(workerCore).toContain("role = 'boss'");
    expect(workerCore).not.toContain("role IN ('boss', 'admin')");
  });
});
