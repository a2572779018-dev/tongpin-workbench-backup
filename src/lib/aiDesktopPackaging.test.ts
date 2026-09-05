import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("AI browser libraries in desktop packages", () => {
  it.each(["pdfjs-dist", "mammoth", "pptxgenjs"])("bundles %s with Vite instead of adding its Node dependency tree to Electron", name => {
    expect(packageJson.devDependencies).toHaveProperty(name);
    expect(packageJson.dependencies).not.toHaveProperty(name);
  });

  it("requires the local PDF worker and licenses, and rejects native canvas from the final archive", () => {
    const verifier = readFileSync(new URL("../../scripts/verify-asar-contents.cjs", import.meta.url), "utf8");
    expect(verifier).toContain("/AI_DOCUMENT_LIBRARY_NOTICES.md");
    expect(verifier).toContain("/node_modules/@napi-rs/canvas");
    expect(verifier).toContain("Packaged app is missing the bundled PDF text worker");
    expect(packageJson.build.files).toContain("dist/renderer/**/*");
  });
});
