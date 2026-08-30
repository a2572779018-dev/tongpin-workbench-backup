import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync("cloudflare/src/index.ts", "utf8");
const coreSource = readFileSync("cloudflare/src/core.ts", "utf8");

describe("Cloudflare LORA collection routing policy", () => {
  it("keeps aggregate collection out of the stateless scheduled handler", () => {
    expect(indexSource).not.toContain('from "./lora-aggregate"');
    expect(indexSource).not.toContain("new ExplorerLoraChainDataSource");
    expect(indexSource).toContain('env.TONGPIN_CORE.idFromName("primary")');
    expect(indexSource).toContain("LORA_INTERNAL_COLLECT_PATH");
    const scheduledSource = indexSource.slice(indexSource.indexOf("scheduled("));
    expect(scheduledSource).not.toContain(".catch(");
  });

  it("blocks the private collection path before API forwarding", () => {
    const privatePathGuard = indexSource.indexOf(
      "url.pathname === LORA_INTERNAL_COLLECT_PATH",
    );
    const apiForwarding = indexSource.indexOf(
      'url.pathname.startsWith("/api/")',
    );
    expect(privatePathGuard).toBeGreaterThan(-1);
    expect(privatePathGuard).toBeLessThan(apiForwarding);
  });

  it("deduplicates and awaits aggregate collection in the Durable Object", () => {
    expect(coreSource).toContain("loraAggregateCollectionInFlight");
    expect(coreSource).toContain("await this.runLoraAggregateCollection()");
    expect(coreSource).toContain("collectLoraAggregateSnapshot({");
  });
});
