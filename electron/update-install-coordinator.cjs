"use strict";

function createUpdateInstallCoordinator({
  app,
  updater,
  platform = process.platform,
  prepareInstallerEnvironment = () => {},
  closeAuxiliaryWindows = () => {},
  onInstallError = () => {},
  onDeferredInstallError = () => {},
  schedule = setTimeout,
  logger = console,
  shutdownDelayMs = 120,
}) {
  let installRequested = false;
  let installerStarted = false;
  const isMac = platform === "darwin";

  app.on("quit", () => {
    if (isMac || !installRequested || installerStarted) return;
    installerStarted = true;

    let started = false;
    try {
      started = updater.install(true, true);
    } catch {
      started = false;
    }
    if (!started) {
      logger.error("[updater] installer-start-failed-after-exit");
      onDeferredInstallError();
    }
  });

  function requestInstall() {
    if (installRequested) return false;

    installRequested = true;

    if (isMac) {
      try {
        closeAuxiliaryWindows();
        updater.quitAndInstall();
        return true;
      } catch {
        installRequested = false;
        logger.error("[updater] installer-start-failed");
        return false;
      }
    }

    updater.autoInstallOnAppQuit = false;

    let shutdownTimer;
    try {
      shutdownTimer = schedule(() => {
        try {
          prepareInstallerEnvironment();
          closeAuxiliaryWindows();
          app.quit();
        } catch {
          installRequested = false;
          updater.autoInstallOnAppQuit = true;
          logger.error("[updater] installer-preparation-failed");
          onInstallError();
        }
      }, shutdownDelayMs);
    } catch {
      installRequested = false;
      updater.autoInstallOnAppQuit = true;
      logger.error("[updater] installer-schedule-failed");
      return false;
    }
    shutdownTimer?.unref?.();

    return true;
  }

  return {
    requestInstall,
    isInstallRequested: () => installRequested,
  };
}

module.exports = {
  createUpdateInstallCoordinator,
};
