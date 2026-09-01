import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  verifyRelationshipMemberAccess,
} = require("../../electron/relationship-member-verifier.cjs") as {
  verifyRelationshipMemberAccess(options: {
    apiUrl: string;
    current: {
      userId: string;
      accessToken: string;
      fingerprint: string;
    };
    fetchImpl: (
      url: string,
      options: { headers: Record<string, string>; signal?: AbortSignal },
    ) => Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>;
    readBinding: () => Promise<unknown>;
    writeBinding: (current: unknown) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

const current = {
  userId: "member-a",
  accessToken: "access-token",
  fingerprint: "refresh-token-fingerprint",
};

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: "https://notify.example.test/",
    current,
    fetchImpl: vi.fn().mockResolvedValue(
      response(200, { user: { id: current.userId, role: "member" } }),
    ),
    readBinding: vi.fn().mockResolvedValue(null),
    writeBinding: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("relationship member verification", () => {
  it("uses the injected fetch client and stores a binding after online verification", async () => {
    const input = options();

    await expect(verifyRelationshipMemberAccess(input)).resolves.toBe(current);
    expect(input.fetchImpl).toHaveBeenCalledWith(
      "https://notify.example.test/api/auth/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer access-token" },
      }),
    );
    expect(input.writeBinding).toHaveBeenCalledWith(current);
    expect(input.readBinding).not.toHaveBeenCalled();
  });

  it("reports a local security-storage error when a verified binding cannot be written", async () => {
    const input = options({
      writeBinding: vi.fn().mockRejectedValue(new Error("系统安全存储不可用")),
    });

    await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
      code: "LOCAL_SECURITY_UNAVAILABLE",
      message: "本机安全验证状态无法读写，请恢复系统安全存储后重试",
    });
    expect(input.readBinding).not.toHaveBeenCalled();
  });

  it("allows an offline fallback only when the encrypted binding matches", async () => {
    const input = options({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
      readBinding: vi.fn().mockResolvedValue({
        userId: current.userId,
        sessionFingerprint: current.fingerprint,
      }),
    });

    await expect(verifyRelationshipMemberAccess(input)).resolves.toBe(current);
    expect(input.writeBinding).not.toHaveBeenCalled();
  });

  it("rejects an offline fallback when the local binding does not match", async () => {
    const input = options({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
      readBinding: vi.fn().mockResolvedValue({
        userId: current.userId,
        sessionFingerprint: "another-session",
      }),
    });

    await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
      code: "NETWORK_UNVERIFIED",
      message: "网络不可用，当前账号尚未完成本机安全验证",
    });
  });

  it("allows the same matching binding fallback for a 5xx server failure", async () => {
    const input = options({
      fetchImpl: vi.fn().mockResolvedValue(response(503)),
      readBinding: vi.fn().mockResolvedValue({
        userId: current.userId,
        sessionFingerprint: current.fingerprint,
      }),
    });

    await expect(verifyRelationshipMemberAccess(input)).resolves.toBe(current);
    expect(input.readBinding).toHaveBeenCalledOnce();
  });

  it("keeps a 5xx server failure distinct from a transport failure when no binding matches", async () => {
    const input = options({
      fetchImpl: vi.fn().mockResolvedValue(response(503)),
      readBinding: vi.fn().mockResolvedValue(null),
    });

    await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
      code: "SERVER_UNVERIFIED",
      message: "公司服务器暂时不可用，当前账号尚未完成本机安全验证",
    });
  });

  it("reports local secure-storage failures while attempting an offline binding", async () => {
    const input = options({
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
      readBinding: vi.fn().mockRejectedValue(new Error("系统安全存储不可用")),
    });

    await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
      code: "LOCAL_SECURITY_UNAVAILABLE",
      message: "本机安全验证状态无法读写，请恢复系统安全存储后重试",
    });
  });

  it.each([401, 403])(
    "never falls back to a local binding after HTTP %s",
    async (status) => {
      const input = options({
        fetchImpl: vi.fn().mockResolvedValue(response(status)),
        readBinding: vi.fn().mockResolvedValue({
          userId: current.userId,
          sessionFingerprint: current.fingerprint,
        }),
      });

      await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
        code: "AUTH_EXPIRED",
        message: "登录状态已失效，请重新登录",
      });
      expect(input.readBinding).not.toHaveBeenCalled();
    },
  );

  it("does not use an offline binding for non-5xx service rejections", async () => {
    const input = options({
      fetchImpl: vi.fn().mockResolvedValue(response(429)),
      readBinding: vi.fn().mockResolvedValue({
        userId: current.userId,
        sessionFingerprint: current.fingerprint,
      }),
    });

    await expect(verifyRelationshipMemberAccess(input)).rejects.toMatchObject({
      code: "VERIFY_FAILED",
      message: "无法验证当前成员账号",
    });
    expect(input.readBinding).not.toHaveBeenCalled();
  });
});
