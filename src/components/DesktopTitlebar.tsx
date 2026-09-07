import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

export function DesktopTitlebar({
  centerLabel,
  hideBrandMark = false,
}: {
  centerLabel?: string;
  hideBrandMark?: boolean;
}) {
  const desktop = window.tongpin;
  const isMac = desktop?.platform === "darwin";
  const appVersion = desktop?.versions.app?.trim();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;

    document.body.classList.add("desktop-runtime");
    if (isMac) {
      document.body.classList.add("desktop-runtime--mac");
      return () => {
        document.body.classList.remove(
          "desktop-runtime",
          "desktop-runtime--mac",
        );
      };
    }

    void desktop.windowControls
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
    const unsubscribe = desktop.windowControls.onMaximizedChange(setMaximized);

    return () => {
      document.body.classList.remove("desktop-runtime");
      unsubscribe();
    };
  }, [desktop, isMac]);

  if (!desktop) return null;

  return (
    <header
      className="desktop-titlebar"
      onDoubleClick={
        isMac
          ? undefined
          : () => void desktop.windowControls.toggleMaximize()
      }
    >
      <div className="desktop-titlebar__brand">
        {!hideBrandMark && <span className="desktop-titlebar__mark" aria-hidden="true">
          <i />
          <i />
        </span>}
        <span className="desktop-titlebar__wordmark">
          <span className="desktop-titlebar__brand-line">
            <b>同频</b>
            {appVersion && (
              <em title={`当前版本 v${appVersion}`}>v{appVersion}</em>
            )}
          </span>
          <small>TONGPIN</small>
        </span>
      </div>

      <div
        className={[
          "desktop-titlebar__status",
          centerLabel ? "is-page-title" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      >
        {!centerLabel && <span />}
        {centerLabel ?? "INTERNAL WORKSPACE"}
      </div>

      {!isMac && (
        <div
          className="desktop-titlebar__controls"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label="最小化窗口"
            title="最小化"
            onClick={() => void desktop.windowControls.minimize()}
          >
            <Minus size={17} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label={maximized ? "还原窗口" : "最大化窗口"}
            title={maximized ? "还原" : "最大化"}
            onClick={() => void desktop.windowControls.toggleMaximize()}
          >
            {maximized ? (
              <Copy size={14} strokeWidth={2.2} />
            ) : (
              <Square size={14} strokeWidth={2.2} />
            )}
          </button>
          <button
            className="desktop-titlebar__close"
            type="button"
            aria-label="关闭窗口"
            title="关闭"
            onClick={() => void desktop.windowControls.close()}
          >
            <X size={17} strokeWidth={2.2} />
          </button>
        </div>
      )}
    </header>
  );
}
