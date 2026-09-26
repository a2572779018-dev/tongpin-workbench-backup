import {
  RELATIONSHIP_GRAPH_MIRROR_AVATAR_MAX_CHARS,
  RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES,
  type RelationshipGraphSnapshotMeta,
  type RelationshipGraphUploadRequest,
} from "../../shared/relationshipGraphMirror";

/**
 * Member → server mirror of the 客户脉络图.
 *
 * The renderer uploads after the encrypted local save succeeded: it already
 * holds the serialized graph, owns the refreshing API session and can shrink
 * avatars with a canvas. The main process would need its own token refresh,
 * which would race the renderer's rotating refresh token. Every failure here is
 * isolated from local saving; the local vault stays the source of truth.
 */

export type AvatarThumbnailer = (dataUrl: string) => Promise<string | null>;

export interface RelationshipGraphMirror {
  request: RelationshipGraphUploadRequest;
  bytes: number;
}

export class RelationshipGraphMirrorTooLargeError extends Error {
  readonly code = "RELATIONSHIP_GRAPH_TOO_LARGE";

  constructor() {
    super("客户脉络图超过 5 MB，无法同步给老板");
    this.name = "RelationshipGraphMirrorTooLargeError";
  }
}

/** Total characters of downscaled avatars kept in one mirror. */
export const RELATIONSHIP_GRAPH_MIRROR_AVATAR_BUDGET = 1_500_000;
const MIRROR_AVATAR = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const SOURCE_AVATAR = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMirrorAvatar(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= RELATIONSHIP_GRAPH_MIRROR_AVATAR_MAX_CHARS &&
    MIRROR_AVATAR.test(value)
  );
}

function hasAvatar(person: unknown): boolean {
  return isRecord(person) && person.avatar !== undefined && person.avatar !== null && person.avatar !== "";
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Build the upload for one locally saved graph document (the exact text the
 * encrypted vault stores). Avatars are downscaled to small thumbnails within a
 * budget; anything else (too large, blob: URLs, failed decoding) is omitted
 * and counted so the boss view can say so. Deterministic for the same input.
 */
export async function buildRelationshipGraphMirror(
  content: string,
  localVersion: number,
  options: { thumbnail?: AvatarThumbnailer } = {},
): Promise<RelationshipGraphMirror> {
  const document = JSON.parse(content) as unknown;
  if (!isRecord(document) || !Array.isArray(document.people)) {
    throw new Error("本机客户脉络图数据无效");
  }
  const sourcePeople: unknown[] = document.people;
  let avatarsOmitted = 0;
  let avatarBudget = RELATIONSHIP_GRAPH_MIRROR_AVATAR_BUDGET;
  const people: unknown[] = [];
  for (const person of sourcePeople) {
    if (!isRecord(person) || !hasAvatar(person)) {
      people.push(person);
      continue;
    }
    const avatar = person.avatar;
    let mirrored: string | null = null;
    if (isMirrorAvatar(avatar)) {
      mirrored = avatar;
    } else if (
      typeof avatar === "string" &&
      SOURCE_AVATAR.test(avatar) &&
      options.thumbnail
    ) {
      try {
        const thumbnail = await options.thumbnail(avatar);
        if (isMirrorAvatar(thumbnail)) mirrored = thumbnail;
      } catch {
        mirrored = null;
      }
    }
    if (mirrored !== null && mirrored.length <= avatarBudget) {
      avatarBudget -= mirrored.length;
      people.push({ ...person, avatar: mirrored });
    } else {
      avatarsOmitted += 1;
      people.push({ ...person, avatar: null });
    }
  }

  const generatedAt =
    typeof document.generatedAt === "string" ? Date.parse(document.generatedAt) : Number.NaN;
  const updatedAt = new Date(Number.isFinite(generatedAt) ? generatedAt : Date.now()).toISOString();
  const encoder = new TextEncoder();
  let graph: JsonRecord = { ...document, people };
  let encoded = encoder.encode(JSON.stringify(graph));
  if (encoded.byteLength > RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES) {
    // Text first: drop every avatar before giving up on the mirror.
    graph = {
      ...document,
      people: people.map((person) =>
        isRecord(person) && hasAvatar(person) ? { ...person, avatar: null } : person,
      ),
    };
    avatarsOmitted = sourcePeople.filter(hasAvatar).length;
    encoded = encoder.encode(JSON.stringify(graph));
    if (encoded.byteLength > RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES) {
      throw new RelationshipGraphMirrorTooLargeError();
    }
  }
  return {
    request: {
      graph,
      localVersion,
      contentHash: await sha256Hex(encoded),
      updatedAt,
      avatarsOmitted,
    },
    bytes: encoded.byteLength,
  };
}

export type RelationshipGraphSyncPhase =
  | "idle"
  | "pending"
  | "syncing"
  | "synced"
  | "elsewhere"
  | "retrying"
  | "too-large"
  | "unavailable"
  | "blocked"
  | "failed";

export interface RelationshipGraphSyncStatus {
  phase: RelationshipGraphSyncPhase;
  syncedAt: string | null;
  avatarsOmitted: number;
}

export interface RelationshipGraphSnapshotEvent {
  content: string | null;
  revision: number;
}

export interface RelationshipGraphSyncOptions {
  upload(
    request: RelationshipGraphUploadRequest,
  ): Promise<{ snapshot: RelationshipGraphSnapshotMeta }>;
  fetchRemote(): Promise<{ snapshot: RelationshipGraphSnapshotMeta | null }>;
  buildMirror(content: string, localVersion: number): Promise<RelationshipGraphMirror>;
  onStatus(status: RelationshipGraphSyncStatus): void;
  /** Quiet period after the last local save before uploading. */
  debounceMs?: number;
  /** Upper bound while the member keeps editing. */
  maxWaitMs?: number;
  /** Delay of the one comparison after opening, so the map renders first. */
  openCheckDelayMs?: number;
  retryDelaysMs?: readonly number[];
  /** After a 404/405 (backend without this route) wait before trying again. */
  unavailableCooldownMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RelationshipGraphSync {
  /** The vault was opened; upload once if the server copy is missing or older. */
  noteLoaded(event: RelationshipGraphSnapshotEvent): void;
  /** A local encrypted save succeeded; upload after the debounce. */
  noteSaved(event: RelationshipGraphSnapshotEvent): void;
  flush(): Promise<void>;
  /** Stops timers; with `flush` the pending upload still runs once, silently. */
  dispose(options?: { flush?: boolean }): void;
  status(): RelationshipGraphSyncStatus;
}

type SyncFailure =
  | "transient"
  | "too-large"
  | "unavailable"
  | "blocked"
  | "account-changed"
  | "failed";

export function classifyRelationshipGraphSyncError(error: unknown): SyncFailure {
  if (error instanceof RelationshipGraphMirrorTooLargeError) return "too-large";
  const details: JsonRecord = isRecord(error) ? error : {};
  const status = typeof details.status === "number" ? details.status : undefined;
  const code = typeof details.code === "string" ? details.code : "";
  if (code === "AI_ACCOUNT_CHANGED") return "account-changed";
  if (
    status === 413 ||
    code === "RELATIONSHIP_GRAPH_TOO_LARGE" ||
    code === "PAYLOAD_TOO_LARGE"
  ) {
    return "too-large";
  }
  if (
    status === undefined ||
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    code === "NETWORK_UNAVAILABLE"
  ) {
    return "transient";
  }
  if (status === 404 || status === 405) return "unavailable";
  if (status === 401 || status === 403) return "blocked";
  return "failed";
}

const DEFAULT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

function validEvent(
  event: RelationshipGraphSnapshotEvent | null | undefined,
): event is { content: string; revision: number } {
  return (
    typeof event?.content === "string" &&
    Number.isSafeInteger(event.revision) &&
    event.revision >= 1
  );
}

export function createRelationshipGraphSync(
  options: RelationshipGraphSyncOptions,
): RelationshipGraphSync {
  const debounceMs = options.debounceMs ?? 8_000;
  const maxWaitMs = options.maxWaitMs ?? 45_000;
  const openCheckDelayMs = options.openCheckDelayMs ?? 1_500;
  const retryDelays = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  const unavailableCooldownMs = options.unavailableCooldownMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let latest: { content: string; revision: number } | null = null;
  /** `latest` has not been confirmed on the server yet. */
  let dirty = false;
  /** `latest` came from opening the vault, not from a save. */
  let openCheck = false;
  let lastSyncedHash: string | null = null;
  let timer: unknown = null;
  let firstPendingAt: number | null = null;
  let retryIndex = 0;
  let unavailableUntil = 0;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let disposed = false;
  /** Disposed without flushing: in-flight work stops at the next checkpoint. */
  let abandoned = false;
  let stopped = false;
  let current: RelationshipGraphSyncStatus = {
    phase: "idle",
    syncedAt: null,
    avatarsOmitted: 0,
  };

  function emit(patch: Partial<RelationshipGraphSyncStatus>) {
    const next = { ...current, ...patch };
    if (
      next.phase === current.phase &&
      next.syncedAt === current.syncedAt &&
      next.avatarsOmitted === current.avatarsOmitted
    ) {
      return;
    }
    current = next;
    if (disposed) return;
    try {
      options.onStatus(current);
    } catch {
      // Status display must never affect syncing or local saving.
    }
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs: number) {
    cancelTimer();
    if (disposed || stopped) return;
    timer = setTimer(() => {
      timer = null;
      void run();
    }, Math.max(0, delayMs));
  }

  /** Returns true when `target` is still the newest local graph. */
  function settle(target: { content: string; revision: number }): boolean {
    if (latest !== target) return false;
    dirty = false;
    openCheck = false;
    return true;
  }

  async function attempt(target: { content: string; revision: number }, checkRemote: boolean) {
    let mirror: RelationshipGraphMirror;
    try {
      mirror = await options.buildMirror(target.content, target.revision);
    } catch (error) {
      settle(target);
      emit({ phase: error instanceof RelationshipGraphMirrorTooLargeError ? "too-large" : "failed" });
      return;
    }
    if (abandoned || stopped) return;
    const hash = mirror.request.contentHash;
    if (hash === lastSyncedHash) {
      emit({ phase: settle(target) ? "synced" : "pending" });
      return;
    }
    try {
      if (checkRemote) {
        const remote = (await options.fetchRemote()).snapshot;
        if (abandoned || stopped) return;
        if (remote?.contentHash === hash) {
          lastSyncedHash = hash;
          retryIndex = 0;
          emit({
            phase: settle(target) ? "synced" : "pending",
            syncedAt: remote.syncedAt,
            avatarsOmitted: remote.avatarsOmitted,
          });
          return;
        }
        if (remote && Date.parse(remote.updatedAt) > Date.parse(mirror.request.updatedAt)) {
          // Another computer of this member saved later; the next local save wins.
          retryIndex = 0;
          emit({
            phase: settle(target) ? "elsewhere" : "pending",
            syncedAt: remote.syncedAt,
            avatarsOmitted: remote.avatarsOmitted,
          });
          return;
        }
      }
      emit({ phase: "syncing" });
      const result = await options.upload(mirror.request);
      lastSyncedHash = hash;
      retryIndex = 0;
      emit({
        phase: settle(target) ? "synced" : "pending",
        syncedAt: result.snapshot.syncedAt,
        avatarsOmitted: result.snapshot.avatarsOmitted,
      });
    } catch (error) {
      const failure = classifyRelationshipGraphSyncError(error);
      if (failure === "account-changed") {
        stopped = true;
        cancelTimer();
        return;
      }
      if (failure === "transient") {
        const delay = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
        retryIndex += 1;
        emit({ phase: "retrying" });
        // A newer save already scheduled its own upload.
        if (latest === target) schedule(delay);
        return;
      }
      settle(target);
      if (failure === "unavailable") unavailableUntil = now() + unavailableCooldownMs;
      emit({ phase: failure });
    }
  }

  function run(): Promise<void> {
    cancelTimer();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    if (stopped || abandoned || !latest || !dirty) return Promise.resolve();
    if (now() < unavailableUntil) {
      // At most one attempt per cooldown; the newest graph goes up once it ends.
      emit({ phase: "unavailable" });
      schedule(unavailableUntil - now());
      return Promise.resolve();
    }
    const target = latest;
    const checkRemote = openCheck;
    firstPendingAt = null;
    const operation = attempt(target, checkRemote)
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
        if (rerun) {
          rerun = false;
          if (dirty && !stopped && !abandoned) void run();
        }
      });
    inFlight = operation;
    return operation;
  }

  return {
    noteLoaded(event) {
      if (disposed || stopped || !validEvent(event)) return;
      // A save noted meanwhile is newer than what was opened.
      if (dirty && !openCheck) return;
      latest = { content: event.content, revision: event.revision };
      dirty = true;
      openCheck = true;
      schedule(openCheckDelayMs);
    },
    noteSaved(event) {
      if (disposed || stopped || !validEvent(event)) return;
      latest = { content: event.content, revision: event.revision };
      dirty = true;
      openCheck = false;
      retryIndex = 0;
      const at = now();
      if (firstPendingAt === null) firstPendingAt = at;
      if (!inFlight) emit({ phase: "pending" });
      schedule(Math.min(debounceMs, firstPendingAt + maxWaitMs - at));
    },
    flush() {
      return run();
    },
    dispose({ flush = false } = {}) {
      if (disposed) return;
      const pending = flush && dirty && !stopped;
      disposed = true;
      abandoned = !flush;
      cancelTimer();
      if (pending) void run();
    },
    status() {
      return current;
    },
  };
}

function formatSyncTime(iso: string, nowMs: number): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const today = new Date(nowMs);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

export const RELATIONSHIP_GRAPH_BOSS_NOTE = "客户脉络图会同步给老板查看";

/** Compact text for the note next to the member's local save status. */
export function describeRelationshipGraphSync(
  status: RelationshipGraphSyncStatus,
  nowMs = Date.now(),
): { tone: "muted" | "ok" | "warn"; text: string } {
  const suffix = (() => {
    switch (status.phase) {
      case "pending":
        return { tone: "muted" as const, text: "待同步" };
      case "syncing":
        return { tone: "muted" as const, text: "正在同步" };
      case "synced": {
        const time = status.syncedAt ? formatSyncTime(status.syncedAt, nowMs) : "";
        return { tone: "ok" as const, text: time ? `已同步 ${time}` : "已同步" };
      }
      case "elsewhere":
        return { tone: "muted" as const, text: "老板端为其他电脑较新版本" };
      case "retrying":
        return { tone: "warn" as const, text: "同步失败，稍后自动重试" };
      case "too-large":
        return { tone: "warn" as const, text: "超过 5 MB，暂未同步" };
      case "unavailable":
        return { tone: "warn" as const, text: "服务器暂未开放同步" };
      case "blocked":
        return { tone: "warn" as const, text: "暂时无法同步，请重新登录" };
      case "failed":
        return { tone: "warn" as const, text: "同步失败，下次保存时重试" };
      default:
        return null;
    }
  })();
  return suffix
    ? { tone: suffix.tone, text: `${RELATIONSHIP_GRAPH_BOSS_NOTE} · ${suffix.text}` }
    : { tone: "muted", text: RELATIONSHIP_GRAPH_BOSS_NOTE };
}

/**
 * Browser-only: shrink one avatar to a small square thumbnail (cover crop, as
 * the circular node shows it). Returns null when decoding or encoding fails.
 */
export async function createAvatarThumbnail(
  dataUrl: string,
  size = 72,
): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const scale = Math.max(size / width, size / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
  for (const [type, quality] of [
    ["image/webp", 0.72],
    ["image/jpeg", 0.78],
  ] as const) {
    const result = canvas.toDataURL(type, quality);
    if (isMirrorAvatar(result) && result.startsWith(`data:${type};`)) return result;
  }
  return null;
}
