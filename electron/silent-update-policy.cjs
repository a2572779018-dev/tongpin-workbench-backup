"use strict";

const SILENT_INSTALL_START_HOUR = 2;
const SILENT_INSTALL_END_HOUR = 6;
const SILENT_INSTALL_MIN_IDLE_SECONDS = 10 * 60;

function shouldInstallSilently({
  updateReady,
  installRequested,
  now,
  idleSeconds,
}) {
  if (!updateReady || installRequested) return false;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  if (!Number.isFinite(idleSeconds)) return false;

  const hour = now.getHours();
  const insideMaintenanceWindow =
    hour >= SILENT_INSTALL_START_HOUR && hour < SILENT_INSTALL_END_HOUR;

  return (
    insideMaintenanceWindow &&
    idleSeconds >= SILENT_INSTALL_MIN_IDLE_SECONDS
  );
}

module.exports = {
  SILENT_INSTALL_START_HOUR,
  SILENT_INSTALL_END_HOUR,
  SILENT_INSTALL_MIN_IDLE_SECONDS,
  shouldInstallSilently,
};
