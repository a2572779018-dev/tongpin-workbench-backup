import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
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
import { useAuth } from "../auth/AuthContext";
import { useNotificationToolbar } from "../components/NotificationToolbarContext";
import {
  RELATIONSHIP_GRAPH_ME_PATH,
  type RelationshipGraphOwnSnapshotResponse,
  type RelationshipGraphSnapshotMeta,
} from "../../shared/relationshipGraphMirror";
import {
  buildRelationshipGraphMirror,
  createAvatarThumbnail,
  createRelationshipGraphSync,
  describeRelationshipGraphSync,
  type RelationshipGraphSnapshotEvent,
  type RelationshipGraphSync,
  type RelationshipGraphSyncStatus,
} from "../lib/relationshipGraphSync";

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

/** Isolated shadow root carrying the editor's own CSS (member page and boss viewer). */
function useRelationshipMapShadowMount(resetKey: string) {
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
  }, [resetKey]);

  return { hostRef, mountNode };
}

type MirrorEvent = { kind: "loaded" | "saved"; snapshot: RelationshipGraphSnapshotEvent };

/**
 * Member → boss mirror. Rendered only for real members (never in preview), so
 * the preview keeps working without an AuthProvider. Uploads use the renderer
 * session (with its refresh) and are bound to this account via the header.
 */
function RelationshipGraphMirrorBridge({
  userId,
  controllerRef,
  lastEventRef,
  onStatus,
}: {
  userId: string;
  controllerRef: MutableRefObject<RelationshipGraphSync | null>;
  lastEventRef: MutableRefObject<MirrorEvent | null>;
  onStatus: (status: RelationshipGraphSyncStatus) => void;
}) {
  const { api } = useAuth();

  useEffect(() => {
    const headers = { "X-Tongpin-Account": userId };
    const thumbnails = new Map<string, Promise<string | null>>();
    const thumbnail = (dataUrl: string) => {
      let pending = thumbnails.get(dataUrl);
      if (!pending) {
        pending = createAvatarThumbnail(dataUrl).catch(() => null);
        thumbnails.set(dataUrl, pending);
      }
      return pending;
    };
    const controller = createRelationshipGraphSync({
      upload: (request) =>
        api<{ snapshot: RelationshipGraphSnapshotMeta }>(
          RELATIONSHIP_GRAPH_ME_PATH,
          { method: "PUT", headers, body: JSON.stringify(request) },
          60_000,
        ),
      fetchRemote: () =>
        api<RelationshipGraphOwnSnapshotResponse>(RELATIONSHIP_GRAPH_ME_PATH, { headers }),
      buildMirror: (content, revision) =>
        buildRelationshipGraphMirror(content, revision, { thumbnail }),
      onStatus,
    });
    controllerRef.current = controller;
    // Replay an open/save that happened before this effect ran.
    const last = lastEventRef.current;
    if (last?.kind === "saved") controller.noteSaved(last.snapshot);
    else if (last?.kind === "loaded") controller.noteLoaded(last.snapshot);
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.dispose({ flush: true });
    };
  }, [api, controllerRef, lastEventRef, onStatus, userId]);

  return null;
}

export function RelationshipMapPage({
  userId,
  previewMode = false,
}: {
  userId: string;
  previewMode?: boolean;
}) {
  const { hostRef, mountNode } = useRelationshipMapShadowMount(userId);
  const notificationToolbar = useNotificationToolbar();
  const mirrorControllerRef = useRef<RelationshipGraphSync | null>(null);
  const mirrorLastEventRef = useRef<MirrorEvent | null>(null);
  const [mirrorStatus, setMirrorStatus] = useState<RelationshipGraphSyncStatus>({
    phase: "idle",
    syncedAt: null,
    avatarsOmitted: 0,
  });
  const noteSecureGraphLoaded = useCallback((snapshot: RelationshipGraphSnapshotEvent) => {
    mirrorLastEventRef.current = { kind: "loaded", snapshot };
    mirrorControllerRef.current?.noteLoaded(snapshot);
  }, []);
  const noteSecureGraphSaved = useCallback((snapshot: RelationshipGraphSnapshotEvent) => {
    mirrorLastEventRef.current = { kind: "saved", snapshot };
    mirrorControllerRef.current?.noteSaved(snapshot);
  }, []);
  const bossSyncStatus = useMemo(
    () => (previewMode ? null : describeRelationshipGraphSync(mirrorStatus)),
    [mirrorStatus, previewMode],
  );

  return (
    <main className="relationship-map-page" aria-label="客户脉络图">
      {previewMode ? null : (
        <RelationshipGraphMirrorBridge
          key={userId}
          userId={userId}
          controllerRef={mirrorControllerRef}
          lastEventRef={mirrorLastEventRef}
          onStatus={setMirrorStatus}
        />
      )}
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
              notificationUnread={notificationToolbar?.unread ?? 0}
              onOpenNotifications={
                notificationToolbar?.openNotificationDrawer
              }
              onSecureGraphLoaded={previewMode ? undefined : noteSecureGraphLoaded}
              onSecureGraphSaved={previewMode ? undefined : noteSecureGraphSaved}
              bossSyncStatus={bossSyncStatus}
            />,
            mountNode,
          )
        : null}
    </main>
  );
}

/**
 * Boss viewer: the same editor components in read-only mode, fed by a member's
 * synced snapshot. No vault, no localStorage graph, no import/export.
 */
export function RelationshipMapReadOnlyView({
  viewerKey,
  graph,
  note,
}: {
  viewerKey: string;
  graph: unknown;
  note: string;
}) {
  const { hostRef, mountNode } = useRelationshipMapShadowMount(viewerKey);

  return (
    <div className="relationship-map-page relationship-map-page--read-only">
      <div key={viewerKey} ref={hostRef} className="relationship-map-host" />
      {mountNode
        ? createPortal(
            <RelationshipMapApp
              key={viewerKey}
              readOnlyGraph={graph}
              readOnlyNote={note}
              themeStorageKey="tongpin.relationship-map.boss-viewer.theme.v1"
            />,
            mountNode,
          )
        : null}
    </div>
  );
}
