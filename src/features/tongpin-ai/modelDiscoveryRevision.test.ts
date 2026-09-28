import { describe, expect, it } from "vitest";
import { ModelDiscoveryRevision } from "./modelDiscoveryRevision";

describe("administrator model discovery identity", () => {
  it("drops a delayed old response after credentials change, but accepts the new one", async () => {
    const gate = new ModelDiscoveryRevision();
    const old = gate.begin("chat");
    let finishOld!: (models: string[]) => void;
    const oldResult = new Promise<string[]>(resolve => { finishOld = resolve; });
    gate.invalidate("chat");
    const current = gate.begin("chat");
    const visible: string[] = [];
    const apply = oldResult.then(models => { if (gate.isCurrent("chat", old)) visible.push(...models); });
    finishOld(["old-key-only"]);
    await apply;
    expect(visible).toEqual([]);
    if (gate.isCurrent("chat", current)) visible.push("new-key-only");
    expect(visible).toEqual(["new-key-only"]);
  });

  it("invalidates pending requests across a settings reload without disturbing other scopes", () => {
    const gate = new ModelDiscoveryRevision();
    const chat = gate.begin("chat");
    const image = gate.begin("image");
    gate.invalidate("chat");
    expect(gate.isCurrent("chat", chat)).toBe(false);
    expect(gate.isCurrent("image", image)).toBe(true);
    gate.invalidateAll();
    expect(gate.isCurrent("image", image)).toBe(false);
  });

  it("never lets an earlier same-provider request overwrite a newer request", () => {
    const gate = new ModelDiscoveryRevision();
    const first = gate.begin("chat");
    const second = gate.begin("chat");
    expect(gate.isCurrent("chat", first)).toBe(false);
    expect(gate.isCurrent("chat", second)).toBe(true);
  });
});
