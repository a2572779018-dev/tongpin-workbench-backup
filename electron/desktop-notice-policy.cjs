function normalizeDesktopNoticePayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.title !== "string" ||
    typeof payload.body !== "string"
  ) {
    return null;
  }
  const requireAcknowledgement = payload.requireAcknowledgement === true;
  const isLoraDashboardAction =
    payload.action?.type === "open-lora-dashboard";
  return {
    notificationId:
      typeof payload.notificationId === "string"
        ? payload.notificationId.slice(0, 80)
        : "",
    title: payload.title.slice(0, 80),
    body: payload.body.slice(0, 400),
    actionLabel:
      typeof payload.actionLabel === "string"
        ? payload.actionLabel.slice(0, 20)
        : undefined,
    action: payload.action,
    tone: requireAcknowledgement ? "warning" : "info",
    requireAcknowledgement,
    autoExpand: requireAcknowledgement || isLoraDashboardAction,
    playSound: payload.playSound === true,
    soundKey:
      typeof payload.soundKey === "string" ? payload.soundKey.slice(0, 160) : "",
  };
}

function shouldPinAndExpandDesktopNotice(payload) {
  return payload?.autoExpand === true && payload?.requireAcknowledgement === true;
}

module.exports = {
  normalizeDesktopNoticePayload,
  shouldPinAndExpandDesktopNotice,
};
