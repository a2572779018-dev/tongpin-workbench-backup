import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publisher = path.join(root, "scripts", "publish-release.mjs");

function runPublisher(platform, phase) {
  const args = [publisher, "--platform", platform];
  if (phase === "verify") args.push("--verify-only");
  if (phase === "artifacts") args.push("--artifacts-only");
  if (phase === "manifest") args.push("--manifest-only");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${platform} ${phase} 阶段失败（code=${code ?? "null"}, signal=${signal ?? "none"}）`,
        ),
      );
    });
  });
}

for (const platform of ["win", "mac"]) {
  await runPublisher(platform, "verify");
}

for (const platform of ["win", "mac"]) {
  await runPublisher(platform, "artifacts");
}

for (const platform of ["win", "mac"]) {
  await runPublisher(platform, "manifest");
}

console.log(
  "Windows 与 macOS 产物均已完整校验，两个更新清单已在产物之后切换。",
);
