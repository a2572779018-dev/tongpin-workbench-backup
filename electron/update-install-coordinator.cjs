"use strict";

function createUpdateInstallCoordinator({
  app,
  updater,
  prepareInstallerEnvironment = () => {},
  closeAuxiliaryWindows = () => {},
  schedule = setTimeout,
  logger = console,
  shutdownDelayMs = 120,
}) {
  let installRequested = false;
  let installerStarted = false;

  app.on("quit", () => {
    if (!installRequested || installerStarted) return;
    installerStarted = true;

    const started = updater.install(true, true);
    if (!started) {
      logger.error(
        "[updater] The downloaded installer could not be started after app exit.",
      );
    }
  });

  function requestInstall() {
    if (installRequested) return false;

    installRequested = true;
    updater.autoInstallOnAppQuit = false;

    const shutdownTimer = schedule(() => {
      try {
        prepareInstallerEnvironment();
      } catch (error) {
        installRequested = false;
        updater.autoInstallOnAppQuit = true;
        logger.error(
          `[updater] Could not prepare the installer environment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      closeAuxiliaryWindows();
      app.quit();
    }, shutdownDelayMs);
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
