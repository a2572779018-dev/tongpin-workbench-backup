const DEFAULT_NOTIFICATION_SOUND_DEDUP_MS = 2_000;
const CUSTOM_NOTIFICATION_SOUND_PREFIX = "boss-notification:";

function isCustomNotificationSoundKey(soundKey) {
  return (
    typeof soundKey === "string" &&
    soundKey.trim().startsWith(CUSTOM_NOTIFICATION_SOUND_PREFIX)
  );
}

function shouldUseCustomNotificationSound(payload) {
  return (
    payload?.playSound === true &&
    payload?.requireAcknowledgement === true &&
    isCustomNotificationSoundKey(payload?.soundKey)
  );
}

function shouldPlayNotificationSound({
  enabled,
  soundKey,
  lastPlayedAt,
  now = Date.now(),
  dedupMs = DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
}) {
  if (enabled !== true || typeof soundKey !== "string" || !soundKey.trim()) {
    return false;
  }
  if (!Number.isFinite(lastPlayedAt)) return true;
  return now - lastPlayedAt >= dedupMs;
}

module.exports = {
  CUSTOM_NOTIFICATION_SOUND_PREFIX,
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
  isCustomNotificationSoundKey,
  shouldPlayNotificationSound,
  shouldUseCustomNotificationSound,
};
