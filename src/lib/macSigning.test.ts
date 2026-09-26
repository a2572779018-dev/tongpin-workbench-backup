import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

const require = createRequire(import.meta.url);
const { macSigningPlan } = require("../../scripts/electron-builder-mac.cjs") as {
  macSigningPlan(env: Record<string, string | undefined>): { mode: string; args: string[] };
};
const identityScript = readFileSync(
  new URL("../../scripts/mac-create-local-signing-identity.sh", import.meta.url),
  "utf8",
);

describe("macOS signing mode for local builds", () => {
  it("keeps today's ad-hoc build when no identity is configured", () => {
    expect(macSigningPlan({})).toEqual(expect.objectContaining({ mode: "ad-hoc", args: ["-c.mac.identity=null"] }));
    expect(macSigningPlan({ TONGPIN_MAC_SIGN_IDENTITY: "   " }).mode).toBe("ad-hoc");
  });

  it("signs with the stable local identity, without hardened runtime, notarization or timestamp", () => {
    expect(macSigningPlan({ TONGPIN_MAC_SIGN_IDENTITY: " Tongpin Local Code Signing " })).toEqual(expect.objectContaining({
      mode: "local-identity",
      args: [
        "-c.mac.identity=Tongpin Local Code Signing",
        "-c.mac.hardenedRuntime=false",
        "-c.mac.notarize=false",
        "-c.mac.timestamp=none",
      ],
    }));
  });

  it("leaves official Developer ID signing (CSC_LINK / CSC_NAME) to electron-builder", () => {
    expect(macSigningPlan({ CSC_NAME: "Tongpin Inc (TEAMID1234)" })).toEqual(expect.objectContaining({ mode: "electron-builder", args: [] }));
    expect(macSigningPlan({ CSC_LINK: "/secure/cert.p12" }).mode).toBe("electron-builder");
  });

  it("rejects ambiguous or Apple-certificate configurations instead of guessing", () => {
    expect(() => macSigningPlan({ TONGPIN_MAC_SIGN_IDENTITY: "Tongpin Local Code Signing", CSC_LINK: "/secure/cert.p12" })).toThrow("不能同时设置");
    expect(() => macSigningPlan({ TONGPIN_MAC_SIGN_IDENTITY: "Developer ID Application: Someone (ABCDE12345)" })).toThrow("CSC_LINK/CSC_NAME");
  });

  it("routes npm run dist:mac through the wrapper and never runs the identity script automatically", () => {
    expect(packageJson.scripts["dist:mac"]).toContain("node scripts/electron-builder-mac.cjs --mac dmg zip --universal --publish never");
    expect(packageJson.scripts["dist:mac"]).not.toMatch(/(?:^|&&\s*)electron-builder --mac/);
    expect(JSON.stringify(packageJson.scripts)).not.toContain("mac-create-local-signing-identity");
    expect(packageJson.build.mac.hardenedRuntime).toBe(true);
    expect(packageJson.build.mac).not.toHaveProperty("identity");
  });

  it("creates a user-scoped, code-signing-only identity (no sudo, no System keychain, no admin trust)", () => {
    const code = identityScript.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
    expect(code).toContain("add-trusted-cert -r trustRoot -p codeSign -k \"$KEYCHAIN\"");
    expect(code).not.toMatch(/add-trusted-cert[^\n]*\s-d\b/);
    // "sudo" appears only inside the refusal message, never as a command.
    expect(code).not.toMatch(/(?:^|[;&|(]\s*|\$\(\s*)sudo\s/m);
    expect(code).toContain('[[ "${EUID:-$(id -u)}" -ne 0 ]]');
    expect(code).not.toContain("/Library/Keychains/System.keychain");
    expect(code).toContain("extendedKeyUsage = critical, codeSigning");
    expect(code).toContain("identity_is_valid");
    expect(code).toContain("trap cleanup EXIT");
    expect(code).not.toMatch(/echo[^\n]*TONGPIN_P12_PASS/);
  });
});
