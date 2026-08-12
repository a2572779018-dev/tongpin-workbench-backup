import { describe, expect, it, vi } from "vitest";
import {
  INSTALL_UPDATE_ERROR_MESSAGE,
  requestImmediateUpdateInstall,
} from "../components/NoticeCenter";

describe("update notice policy", () => {
  it("accepts a successfully started installation", async () => {
    const installUpdate = vi.fn(async () => true);

    await expect(
      requestImmediateUpdateInstall(installUpdate),
    ).resolves.toBeUndefined();
    expect(installUpdate).toHaveBeenCalledOnce();
  });

  it("uses fixed Chinese copy when installation cannot start", async () => {
    await expect(
      requestImmediateUpdateInstall(async () => false),
    ).rejects.toThrow(INSTALL_UPDATE_ERROR_MESSAGE);
  });

  it("never exposes an IPC rejection message", async () => {
    let displayedError = "";
    try {
      await requestImmediateUpdateInstall(async () => {
        throw new Error(
          "https://secret.example/update Headers: Authorization=Bearer token-value",
        );
      });
    } catch (error) {
      displayedError = error instanceof Error ? error.message : String(error);
    }

    expect(displayedError).toBe(INSTALL_UPDATE_ERROR_MESSAGE);
    expect(displayedError).not.toMatch(
      /https?:|headers?|authorization|bearer|token-value/i,
    );
  });
});
