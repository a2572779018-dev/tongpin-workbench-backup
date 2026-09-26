#!/usr/bin/env node
/**
 * Runs electron-builder for macOS and picks the code-signing mode from the
 * environment. It never creates certificates or touches the keychain.
 *
 *  - TONGPIN_MAC_SIGN_IDENTITY="<certificate name>"  (local stable identity)
 *      Signs with a certificate the owner created once with
 *      scripts/mac-create-local-signing-identity.sh. The app keeps the same
 *      code identity across rebuilds/updates, so macOS privacy permissions and
 *      the Keychain access list recognise the updated app. Hardened runtime,
 *      notarization and the Apple timestamp service stay off exactly like
 *      today's unsigned local builds (a self-signed certificate has no Apple
 *      Team ID, which hardened-runtime library validation would reject).
 *  - CSC_LINK / CSC_NAME set  (official Developer ID, see docs/MACOS.md)
 *      Passed through untouched to electron-builder's own signing.
 *  - nothing set  (default, today's behaviour)
 *      `mac.identity=null`: electron-builder skips signing and the bundle
 *      keeps Electron's ad-hoc signature, as with every previous 同频 build.
 */
const { spawnSync } = require("node:child_process");

const APPLE_CERTIFICATE_PREFIX =
  /^(?:Developer ID Application|Developer ID Installer|3rd Party Mac Developer (?:Application|Installer)|Apple Development|Apple Distribution|Mac Developer):/;

function macSigningPlan(env = process.env) {
  const localIdentity = String(env.TONGPIN_MAC_SIGN_IDENTITY ?? "").trim();
  const csc = String(env.CSC_LINK ?? "").trim() || String(env.CSC_NAME ?? "").trim();
  if (localIdentity) {
    if (csc) {
      throw new Error(
        "TONGPIN_MAC_SIGN_IDENTITY 与 CSC_LINK/CSC_NAME 不能同时设置：本机稳定签名和 Apple 正式签名只能二选一。",
      );
    }
    if (APPLE_CERTIFICATE_PREFIX.test(localIdentity) || /[\r\n"]/.test(localIdentity)) {
      throw new Error(
        "TONGPIN_MAC_SIGN_IDENTITY 只接受本机自签名证书的名称；Apple 正式证书请按 docs/MACOS.md 使用 CSC_LINK/CSC_NAME。",
      );
    }
    return {
      mode: "local-identity",
      description: `使用本机稳定签名证书「${localIdentity}」（不启用 hardened runtime / 公证）`,
      args: [
        `-c.mac.identity=${localIdentity}`,
        "-c.mac.hardenedRuntime=false",
        "-c.mac.notarize=false",
        "-c.mac.timestamp=none",
      ],
    };
  }
  if (csc) {
    return {
      mode: "electron-builder",
      description: "使用 CSC_LINK/CSC_NAME 指定的正式签名（electron-builder 默认流程）",
      args: [],
    };
  }
  return {
    mode: "ad-hoc",
    description: "未设置签名身份：保持现有 ad-hoc 构建（跳过 electron-builder 签名）",
    args: ["-c.mac.identity=null"],
  };
}

module.exports = { macSigningPlan };

if (require.main === module) {
  let plan;
  try {
    plan = macSigningPlan();
  } catch (error) {
    console.error(`[mac-sign] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.log(`[mac-sign] ${plan.description}`);
  const cli = require.resolve("electron-builder/cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, ...process.argv.slice(2), ...plan.args],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) {
    console.error(`[mac-sign] electron-builder 启动失败：${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
