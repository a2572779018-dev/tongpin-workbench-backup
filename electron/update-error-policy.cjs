"use strict";

const UPDATE_RETRY_DELAYS_MS = [
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
];
const UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS = 6 * 60 * 60 * 1000;

const FRIENDLY_ERRORS = {
  "channel-missing": {
    title: "更新通道暂未就绪",
    message:
      "软件更新通道暂未准备好，不影响任务同步和老板通知，软件会按正常周期自动重试。",
  },
  "check-network": {
    title: "暂时无法检查更新",
    message:
      "暂时无法检查软件更新，不影响任务同步和老板通知，软件会自动重试。",
  },
  check: {
    title: "暂时无法检查更新",
    message:
      "暂时无法检查软件更新，不影响任务同步和老板通知，软件会自动重试。",
  },
  download: {
    title: "更新下载失败",
    message:
      "软件更新下载未完成，不影响任务同步和老板通知，软件会自动重试。",
  },
  validation: {
    title: "更新校验失败",
    message:
      "软件更新校验未通过，为保护数据已停止安装；不影响任务同步和老板通知，软件会自动重试。",
  },
  signature: {
    title: "更新签名校验失败",
    message:
      "软件更新签名校验未通过，为保护数据已停止安装；不影响任务同步和老板通知，软件会自动重试。",
  },
  install: {
    title: "更新安装未完成",
    message:
      "软件更新安装未完成，不影响任务同步和老板通知，软件会自动重试。",
  },
  update: {
    title: "软件更新暂时失败",
    message:
      "软件更新暂时未完成，不影响任务同步和老板通知，软件会自动重试。",
  },
};

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return [error.code, error.name, error.message, error.stack]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
}

function classification(kind, scope, retry) {
  return {
    kind,
    scope,
    retry,
    title: FRIENDLY_ERRORS[kind].title,
    message: FRIENDLY_ERRORS[kind].message,
  };
}

function classifyUpdateError(error, phase = "checking") {
  const source = errorText(error);
  const mentionsManifest = /\blatest(?:-mac|-linux)?\.ya?ml\b/i.test(source);
  const manifestMissing =
    mentionsManifest &&
    (/\b404\b/i.test(source) ||
      /not\s+found/i.test(source) ||
      /cannot\s+find\s+channel/i.test(source));
  if (manifestMissing) {
    return classification("channel-missing", "check", "normal");
  }

  if (
    /err_updater_invalid_signature|code\s+signature|signature\s+(?:check|validation|verification)|publisher\s+name|not\s+(?:properly\s+)?signed/i.test(
      source,
    )
  ) {
    return classification("signature", "critical", "normal");
  }

  if (
    /sha-?512|checksum|hash\s+mismatch|integrity|invalid\s+(?:package|archive)|blockmap|size\s+mismatch/i.test(
      source,
    )
  ) {
    return classification("validation", "critical", "normal");
  }

  if (
    phase === "installing" ||
    /quitandinstall|installer|installation|failed\s+to\s+install|could\s+not\s+(?:start|launch)/i.test(
      source,
    )
  ) {
    return classification("install", "critical", "normal");
  }

  if (
    phase === "downloading" ||
    /download|content-range|range\s+request/i.test(source)
  ) {
    return classification("download", "critical", "normal");
  }

  const networkFailure =
    /\b(?:eai_again|enotfound|etimedout|econnreset|econnrefused|enetunreach|ehostunreach)\b/i.test(
      source,
    ) ||
    /err_(?:network|connection|internet|proxy|timed_out)|network\s+error|socket\s+hang\s+up|tls|http(?:error)?\s*:?\s*(?:408|425|429|5\d\d)\b/i.test(
      source,
    );
  if (phase === "checking" && networkFailure) {
    return classification("check-network", "check", "backoff");
  }
  if (phase === "checking") {
    return classification("check", "check", "backoff");
  }
  return classification("update", "critical", "normal");
}

function getUpdateRetryDelayMs(failureCount) {
  const normalizedCount = Math.max(1, Math.floor(Number(failureCount) || 1));
  const index = Math.min(
    normalizedCount - 1,
    UPDATE_RETRY_DELAYS_MS.length - 1,
  );
  return UPDATE_RETRY_DELAYS_MS[index];
}

function shouldShowUpdateError({
  errorClass,
  nowMs,
  channelMissingShown = false,
  lastShownAtMs,
}) {
  if (errorClass.scope === "critical") return true;
  if (errorClass.kind === "channel-missing") return !channelMissingShown;
  if (!Number.isFinite(lastShownAtMs)) return true;
  return nowMs - lastShownAtMs >= UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS;
}

module.exports = {
  UPDATE_CHECK_ERROR_NOTICE_THROTTLE_MS,
  UPDATE_RETRY_DELAYS_MS,
  classifyUpdateError,
  getUpdateRetryDelayMs,
  shouldShowUpdateError,
};
