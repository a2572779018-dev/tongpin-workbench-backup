import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./security";

describe("Cloudflare password hashing", () => {
  it("uses the Workers-supported PBKDF2 iteration ceiling", async () => {
    const hash = await hashPassword("StrongPass9!");

    expect(hash.split("$")[1]).toBe("100000");
    await expect(verifyPassword("StrongPass9!", hash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass9!", hash)).resolves.toBe(false);
  });

  it("rejects an unsupported iteration count without throwing", async () => {
    const hash = await hashPassword("StrongPass9!");
    const unsupported = hash.replace("$100000$", "$210000$");

    await expect(verifyPassword("StrongPass9!", unsupported)).resolves.toBe(
      false,
    );
  });
});
