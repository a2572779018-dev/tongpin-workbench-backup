import { useEffect, useLayoutEffect, useState } from "react";
import { ListPlus } from "lucide-react";

interface QuickCornerBridge {
  openPanel(): Promise<unknown>;
  onCornerVisibility(callback: (visible: boolean) => void): () => void;
}

function getBridge(): QuickCornerBridge | undefined {
  return (
    window as unknown as {
      tongpinQuick?: QuickCornerBridge;
    }
  ).tongpinQuick;
}

export function QuickCorner() {
  const isPreview = new URLSearchParams(window.location.search).get("preview") === "1";
  const [visible, setVisible] = useState(isPreview);

  useLayoutEffect(() => {
    document.documentElement.dataset.surface = "quick-corner";
    document.body.classList.add("quick-corner-surface");
    return () => {
      delete document.documentElement.dataset.surface;
      document.body.classList.remove("quick-corner-surface");
    };
  }, []);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) {
      setVisible(true);
      return;
    }

    return bridge.onCornerVisibility(setVisible);
  }, []);

  return (
    <main className={`quick-corner-stage${visible ? " is-visible" : ""}`}>
      <button
        className="quick-corner-button"
        type="button"
        aria-label="打开快捷待办"
        title="快捷待办"
        tabIndex={visible ? 0 : -1}
        onClick={() => void getBridge()?.openPanel()}
      >
        <ListPlus aria-hidden="true" strokeWidth={2.4} />
      </button>
    </main>
  );
}
