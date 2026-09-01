const RELATIONSHIP_MEMBER_VERIFICATION_ERRORS = Object.freeze({
  AUTH_EXPIRED: "登录状态已失效，请重新登录",
  MEMBER_ONLY: "客户脉络图仅供当前成员账号使用",
  VERIFY_FAILED: "无法验证当前成员账号",
  LOCAL_SECURITY:
    "本机安全验证状态无法读写，请恢复系统安全存储后重试",
  NETWORK_UNVERIFIED: "网络不可用，当前账号尚未完成本机安全验证",
  SERVER_UNVERIFIED:
    "公司服务器暂时不可用，当前账号尚未完成本机安全验证",
});

class RelationshipMemberVerificationError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "RelationshipMemberVerificationError";
    this.code = code;
  }
}

function verificationError(code, message, cause) {
  const options = cause === undefined ? undefined : { cause };
  return new RelationshipMemberVerificationError(code, message, options);
}

function bindingMatchesCurrentSession(binding, current) {
  return Boolean(
    binding &&
      binding.userId === current.userId &&
      binding.sessionFingerprint === current.fingerprint,
  );
}

async function verifyFromLocalBinding({ current, readBinding, unavailableKind }) {
  let binding;
  try {
    binding = await readBinding();
  } catch (cause) {
    throw verificationError(
      "LOCAL_SECURITY_UNAVAILABLE",
      RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.LOCAL_SECURITY,
      cause,
    );
  }

  if (bindingMatchesCurrentSession(binding, current)) return current;

  const isServerFailure = unavailableKind === "server";
  throw verificationError(
    isServerFailure ? "SERVER_UNVERIFIED" : "NETWORK_UNVERIFIED",
    isServerFailure
      ? RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.SERVER_UNVERIFIED
      : RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.NETWORK_UNVERIFIED,
  );
}

/**
 * Verifies that the current session still belongs to a member before opening
 * its encrypted relationship graph. Only transport failures and 5xx responses
 * may use a previously verified, matching local binding.
 */
async function verifyRelationshipMemberAccess({
  apiUrl,
  current,
  fetchImpl,
  readBinding,
  writeBinding,
  signal,
}) {
  if (
    !current ||
    typeof current.userId !== "string" ||
    typeof current.accessToken !== "string" ||
    typeof current.fingerprint !== "string"
  ) {
    throw new TypeError("成员登录信息无效");
  }
  if (
    typeof fetchImpl !== "function" ||
    typeof readBinding !== "function" ||
    typeof writeBinding !== "function"
  ) {
    throw new TypeError("成员安全验证配置无效");
  }

  const normalizedApiUrl = String(apiUrl ?? "").replace(/\/+$/, "");
  let response;
  try {
    response = await fetchImpl(`${normalizedApiUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${current.accessToken}` },
      signal,
    });
  } catch {
    return verifyFromLocalBinding({
      current,
      readBinding,
      unavailableKind: "network",
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw verificationError(
      "AUTH_EXPIRED",
      RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.AUTH_EXPIRED,
    );
  }

  if (response.status >= 500 && response.status <= 599) {
    return verifyFromLocalBinding({
      current,
      readBinding,
      unavailableKind: "server",
    });
  }

  if (!response.ok) {
    throw verificationError(
      "VERIFY_FAILED",
      RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.VERIFY_FAILED,
    );
  }

  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw verificationError(
      "INVALID_SERVER_RESPONSE",
      RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.VERIFY_FAILED,
      cause,
    );
  }

  const verifiedUser = result?.user;
  if (verifiedUser?.id !== current.userId || verifiedUser?.role !== "member") {
    throw verificationError(
      "MEMBER_MISMATCH",
      RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.MEMBER_ONLY,
    );
  }

  try {
    await writeBinding(current);
  } catch {
    return {
      ...current,
      bindingWarning: {
        code: "LOCAL_SECURITY_UNAVAILABLE",
        message: RELATIONSHIP_MEMBER_VERIFICATION_ERRORS.LOCAL_SECURITY,
      },
    };
  }
  return current;
}

module.exports = {
  RELATIONSHIP_MEMBER_VERIFICATION_ERRORS,
  RelationshipMemberVerificationError,
  bindingMatchesCurrentSession,
  verifyRelationshipMemberAccess,
};
