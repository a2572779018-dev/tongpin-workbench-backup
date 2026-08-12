import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createUpdateInstallCoordinator } = require(
  "../../electron/update-install-coordinator.cjs",
) as {
  createUpdateInstallCoordinator: (options: {
    app: EventEmitter & { quit: () => void };
    updater: {
      autoInstallOnAppQuit: boolean;
      install: (silent: boolean, forceRunAfter: boolean) => boolean;
      quitAndInstall: () => void;
    };
    platform?: string;
    prepareInstallerEnvironment: () => void;
    closeAuxiliaryWindows: () => void;
    onInstallError: () => void;
    onDeferredInstallError: () => void;
    schedule: (callback: () => void, delay: number) => {
      unref: () => void;
    };
    logger: { error: (message: string) => void };
    shutdownDelayMs?: number;
  }) => {
    requestInstall: () => boolean;
    isInstallRequested: () => boolean;
  };
};

function createHarness(installResult = true, platform = "win32") {
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(),
  });
  const updater = {
    autoInstallOnAppQuit: true,
    install: vi.fn(() => installResult),
    quitAndInstall: vi.fn(),
  };
  const prepareInstallerEnvironment = vi.fn();
  const closeAuxiliaryWindows = vi.fn();
  const onInstallError = vi.fn();
  const onDeferredInstallError = vi.fn();
  const scheduled: Array<() => void> = [];
  const unref = vi.fn();
  const schedule = vi.fn((callback: () => void) => {
    scheduled.push(callback);
    return { unref };
  });
  const logger = { error: vi.fn() };
  const coordinator = createUpdateInstallCoordinator({
    app,
    updater,
    platform,
    prepareInstallerEnvironment,
    closeAuxiliaryWindows,
    onInstallError,
    onDeferredInstallError,
    schedule,
    logger,
  });

  return {
    app,
    updater,
    prepareInstallerEnvironment,
    closeAuxiliaryWindows,
    onInstallError,
    onDeferredInstallError,
    scheduled,
    unref,
    schedule,
    logger,
    coordinator,
  };
}

describe("update install coordinator", () => {
  it("quits the app before starting the downloaded installer", () => {
    const harness = createHarness();

    expect(harness.coordinator.requestInstall()).toBe(true);
    expect(harness.updater.autoInstallOnAppQuit).toBe(false);
    expect(harness.updater.install).not.toHaveBeenCalled();
    expect(harness.schedule).toHaveBeenCalledWith(expect.any(Function), 120);
    expect(harness.unref).toHaveBeenCalledOnce();

    harness.scheduled[0]();
    expect(harness.prepareInstallerEnvironment).toHaveBeenCalledOnce();
    expect(harness.closeAuxiliaryWindows).toHaveBeenCalledOnce();
    expect(harness.app.quit).toHaveBeenCalledOnce();
    expect(harness.updater.install).not.toHaveBeenCalled();

    harness.app.emit("quit");
    expect(harness.updater.install).toHaveBeenCalledWith(true, true);
  });

  it("ignores duplicate install requests and duplicate quit events", () => {
    const harness = createHarness();

    expect(harness.coordinator.requestInstall()).toBe(true);
    expect(harness.coordinator.requestInstall()).toBe(false);
    expect(harness.scheduled).toHaveLength(1);

    harness.app.emit("quit");
    harness.app.emit("quit");
    expect(harness.updater.install).toHaveBeenCalledOnce();
  });

  it("does not start an installer on an ordinary app quit", () => {
    const harness = createHarness();

    harness.app.emit("quit");
    expect(harness.updater.install).not.toHaveBeenCalled();
    expect(harness.updater.autoInstallOnAppQuit).toBe(true);
  });

  it("records a deferred startup failure without launching twice", () => {
    const harness = createHarness(false);

    harness.coordinator.requestInstall();
    harness.app.emit("quit");
    harness.app.emit("quit");

    expect(harness.updater.install).toHaveBeenCalledOnce();
    expect(harness.logger.error).toHaveBeenCalledOnce();
    expect(harness.onDeferredInstallError).toHaveBeenCalledOnce();
    expect(harness.onInstallError).not.toHaveBeenCalled();
  });

  it("does not expose a thrown installer error when recording it", () => {
    const harness = createHarness();
    harness.updater.install.mockImplementation(() => {
      throw new Error(
        "https://secret.example/update Headers: Authorization=Bearer token-value",
      );
    });

    harness.coordinator.requestInstall();
    harness.app.emit("quit");

    expect(harness.onDeferredInstallError).toHaveBeenCalledOnce();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "[updater] installer-start-failed-after-exit",
    );
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toMatch(
      /https?:|headers?|authorization|bearer|token-value/i,
    );
  });

  it("keeps the app open when the same-volume temp directory cannot be prepared", () => {
    const harness = createHarness();
    harness.prepareInstallerEnvironment.mockImplementation(() => {
      throw new Error("temp directory is not writable");
    });

    expect(harness.coordinator.requestInstall()).toBe(true);
    harness.scheduled[0]();

    expect(harness.app.quit).not.toHaveBeenCalled();
    expect(harness.updater.install).not.toHaveBeenCalled();
    expect(harness.updater.autoInstallOnAppQuit).toBe(true);
    expect(harness.coordinator.isInstallRequested()).toBe(false);
    expect(harness.logger.error).toHaveBeenCalledOnce();
    expect(harness.onInstallError).toHaveBeenCalledOnce();
    expect(harness.onDeferredInstallError).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toMatch(
      /temp directory is not writable/i,
    );
  });

  it("uses quitAndInstall directly on macOS", () => {
    const harness = createHarness(true, "darwin");

    expect(harness.coordinator.requestInstall()).toBe(true);
    expect(harness.coordinator.requestInstall()).toBe(false);
    expect(harness.closeAuxiliaryWindows).toHaveBeenCalledOnce();
    expect(harness.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(harness.prepareInstallerEnvironment).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.app.quit).not.toHaveBeenCalled();

    harness.app.emit("quit");
    expect(harness.updater.install).not.toHaveBeenCalled();
  });

  it("returns a fixed failure signal without logging raw macOS errors", () => {
    const harness = createHarness(true, "darwin");
    harness.updater.quitAndInstall.mockImplementation(() => {
      throw new Error(
        "https://secret.example/update Headers: Authorization=Bearer token-value",
      );
    });

    expect(harness.coordinator.requestInstall()).toBe(false);
    expect(harness.coordinator.isInstallRequested()).toBe(false);
    expect(harness.logger.error).toHaveBeenCalledWith(
      "[updater] installer-start-failed",
    );
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toMatch(
      /https?:|headers?|authorization|bearer|token-value/i,
    );
  });
});
