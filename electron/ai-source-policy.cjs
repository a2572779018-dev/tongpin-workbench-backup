"use strict";

// AI citations are untrusted content. This policy is separate from the fixed
// LORA Explorer allowlist and never enables general renderer popup navigation.
function validateAiSourceUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?:00|0a|0d|5c)/i.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (
      !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !host.includes(".") || host.endsWith(".") || host.includes(":") || /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|arpa)$/.test(host) ||
      !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      url.href.length > 2048
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function createAiSourceOpener({ isAllowedSender, confirmOpen, openExternal }) {
  let pending = false;
  return async (event, value) => {
    if (!isAllowedSender(event)) return "blocked";
    const url = validateAiSourceUrl(value);
    if (!url) return "blocked";
    if (pending) return "busy";
    pending = true;
    try {
      if (!(await confirmOpen(url))) return "cancelled";
      if (!isAllowedSender(event)) return "blocked";
      await openExternal(url);
      return "opened";
    } catch {
      return "failed";
    } finally {
      pending = false;
    }
  };
}

module.exports = { validateAiSourceUrl, createAiSourceOpener };
