import { describe, expect, it } from "vitest";
import { decodePrivateImage } from "./ImageArtifact";
import type { AiImageAsset } from "../../../shared/ai";

describe("private image display boundary", () => {
  it("decodes image bytes only after a supported raster signature matches", async () => {
    const blob = decodePrivateImage({ assetId: "test-image", mimeType: "image/png", base64: btoa(String.fromCharCode(137,80,78,71,13,10,26,10,0)) });
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(9);
  });
  it("rejects SVG, MIME spoofing, malformed and excessive base64 data", () => {
    expect(() => decodePrivateImage({ assetId: "x", mimeType: "image/svg+xml", base64: btoa("<svg onload='alert(1)'/>") } as unknown as AiImageAsset)).toThrow("格式");
    expect(() => decodePrivateImage({ assetId: "x", mimeType: "image/png", base64: btoa("<svg/>") })).toThrow("不一致");
    expect(() => decodePrivateImage({ assetId: "x", mimeType: "image/png", base64: "%%%" })).toThrow("格式");
    expect(() => decodePrivateImage({ assetId: "x", mimeType: "image/png", base64: "a".repeat(16_000_001) })).toThrow("过大");
  });
});
