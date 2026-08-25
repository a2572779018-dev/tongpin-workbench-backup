import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import reactFlowCss from "@xyflow/react/dist/style.css?inline";
// The relationship editor intentionally stays in its original JS module so the
// migrated feature can retain its tested data model without widening allowJs.
// @ts-expect-error The JSX module is compiled by Vite and receives typed props below.
import { RelationshipMapApp } from "../features/relationship-map/RelationshipMapApp.jsx";
import {
  graphStorageKeyForMember,
  themeStorageKeyForMember,
// @ts-expect-error The migrated storage module is covered by its own Vitest suite.
} from "../features/relationship-map/data/graphStorage.js";
import relationshipMapCss from "../features/relationship-map/relationship-map.css?inline";
import tongpinThemeCss from "../features/relationship-map/tongpin-theme.css?inline";

const hostCss = `
:host {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  --bg-color: #e0e5ec;
  --surface-raised: #e5eaf1;
  --surface-muted: #dce2ea;
  --shadow-light: #ffffff;
  --shadow-dark: #a3b1c6;
  --text-dark: #242522;
  --text-muted: #68747c;
  --text-soft: #89939a;
  --accent: #80613e;
  --accent-strong: #6c4e32;
  --accent-soft: #dce1e7;
  --bronze: #80613e;
  --oxblood: #742e35;
  --danger-soft: #ead9d7;
  --node-black: #242522;
  --line-color: #44433f;
  color: var(--text-dark);
  background: var(--bg-color);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
}

:host-context(html.custom-cursor-enabled) * {
  cursor: none !important;
}

.relationship-map-mount,
.relationship-map-mount > .app-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.relationship-map-mount > .app-shell {
  width: 100%;
  height: 100%;
}
`;

export function RelationshipMapPage({
  userId,
  previewMode = false,
}: {
  userId: string;
  previewMode?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mountNode, setMountNode] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadowRoot.replaceChildren();

    const style = document.createElement("style");
    style.textContent = [reactFlowCss, relationshipMapCss, tongpinThemeCss, hostCss].join("\n");
    const mount = document.createElement("div");
    mount.className = "relationship-map-mount";
    shadowRoot.append(style, mount);
    setMountNode(mount);
  }, [userId]);

  return (
    <main className="relationship-map-page" aria-label="人物关系爆炸">
      <div key={userId} ref={hostRef} className="relationship-map-host" />
      {mountNode
        ? createPortal(
            <RelationshipMapApp
              allowLocalStorage={previewMode}
              secureStorage={
                previewMode ? null : window.tongpin?.relationshipGraph ?? null
              }
              storageKey={
                previewMode ? graphStorageKeyForMember(userId) : undefined
              }
              themeStorageKey={
                previewMode
                  ? themeStorageKeyForMember(userId)
                  : "tongpin.relationship-map.theme.v1"
              }
            />,
            mountNode,
          )
        : null}
    </main>
  );
}
