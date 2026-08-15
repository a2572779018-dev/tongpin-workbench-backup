import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildLoraExplorerUrl,
  validateLoraExplorerUrl,
}: {
  buildLoraExplorerUrl(target: unknown): string | null;
  validateLoraExplorerUrl(value: unknown): string | null;
} = require("../../electron/lora-explorer-policy.cjs");

const address = "0x1234567890123456789012345678901234567890";
const hash = `0x${"ab".repeat(32)}`;

describe("LORA Explorer desktop policy", () => {
  it("builds only exact address and transaction links", () => {
    expect(buildLoraExplorerUrl({ kind: "address", value: address })).toBe(
      `https://explorer.lorachain.org/address/${address}`,
    );
    expect(buildLoraExplorerUrl({ kind: "tx", value: hash })).toBe(
      `https://explorer.lorachain.org/tx/${hash}`,
    );
  });

  it("rejects malformed identifiers and renderer-provided URLs", () => {
    expect(buildLoraExplorerUrl({ kind: "address", value: `${address}/x` })).toBeNull();
    expect(buildLoraExplorerUrl({ kind: "tx", value: hash.slice(0, -1) })).toBeNull();
    expect(buildLoraExplorerUrl({ kind: "url", value: "https://example.com" })).toBeNull();
    expect(buildLoraExplorerUrl({ kind: "tx", value: "javascript:alert(1)" })).toBeNull();
  });

  it("accepts no host, query, fragment, credentials, or path variation", () => {
    expect(validateLoraExplorerUrl(`https://explorer.lorachain.org/tx/${hash}`)).toBe(
      `https://explorer.lorachain.org/tx/${hash}`,
    );
    expect(validateLoraExplorerUrl(`https://explorer.lorachain.org.evil.test/tx/${hash}`)).toBeNull();
    expect(validateLoraExplorerUrl(`https://explorer.lorachain.org/tx/${hash}?x=1`)).toBeNull();
    expect(validateLoraExplorerUrl(`https://explorer.lorachain.org/tx/${hash}#x`)).toBeNull();
    expect(validateLoraExplorerUrl(`https://user@explorer.lorachain.org/tx/${hash}`)).toBeNull();
    expect(validateLoraExplorerUrl(`http://explorer.lorachain.org/tx/${hash}`)).toBeNull();
  });
});
