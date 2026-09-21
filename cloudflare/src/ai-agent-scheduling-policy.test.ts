import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync("cloudflare/src/index.ts", "utf8");
const coreSource = readFileSync("cloudflare/src/core.ts", "utf8");

describe("Cloudflare AI agent scheduling policy", () => {
  it("invokes the bounded service cycle from cron inside the Durable Object", () => {
    const scheduled = indexSource.slice(indexSource.indexOf("scheduled("));
    expect(scheduled).toContain("AI_INTERNAL_AGENT_TICK_PATH");
    expect(scheduled).toContain('invoke(AI_INTERNAL_AGENT_TICK_PATH, "AI agent")');
    expect(coreSource).toContain("await this.ai.service.runBackgroundAgentCycle(4)");
  });

  it("blocks the private tick path before public API forwarding", () => {
    const guard = indexSource.indexOf("url.pathname === AI_INTERNAL_AGENT_TICK_PATH");
    const forwarding = indexSource.indexOf('url.pathname.startsWith("/api/")');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(forwarding);
    expect(coreSource).toContain("if (path === AI_INTERNAL_AGENT_TICK_PATH)");
  });
});
