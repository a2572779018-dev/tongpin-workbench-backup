const DEFAULT_NOTIFICATION_SOUND_DEDUP_MS = 2_000;

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
  DEFAULT_NOTIFICATION_SOUND_DEDUP_MS,
  shouldPlayNotificationSound,
};
