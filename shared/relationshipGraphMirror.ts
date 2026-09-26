/**
 * Server-side, read-only mirror of a member's 客户脉络图.
 *
 * The member's local encrypted vault stays the only source of truth. After a
 * successful local save the member client uploads a snapshot so the boss of
 * the same organization can view it read-only. Only the latest snapshot per
 * member is kept.
 */

/** UTF-8 bytes of the serialized mirror graph (avatars already downscaled or omitted). */
export const RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES = 5 * 1024 * 1024;
/** Request envelope: graph plus a few metadata fields. */
export const RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES =
  RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES + 64 * 1024;
export const RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE = 5_000;
export const RELATIONSHIP_GRAPH_MIRROR_MAX_CONNECTIONS = 20_000;
/** Downscaled avatar data URL kept in the mirror; larger avatars are omitted. */
export const RELATIONSHIP_GRAPH_MIRROR_AVATAR_MAX_CHARS = 24_000;

export const RELATIONSHIP_GRAPH_ME_PATH = "/api/relationship-graphs/me";
export const BOSS_RELATIONSHIP_GRAPHS_PATH = "/api/boss/relationship-graphs";

/** Metadata shared by the member status endpoint and the boss list. Never contains graph content. */
export interface RelationshipGraphSnapshotMeta {
  /** Revision of the member's local encrypted vault that produced this snapshot. */
  localVersion: number;
  /** SHA-256 (hex) of the stored graph JSON; verified by the server. */
  contentHash: string;
  /** When the member saved this graph locally (member clock). */
  updatedAt: string;
  /** When the server accepted the snapshot (server clock). */
  syncedAt: string;
  contactCount: number;
  connectionCount: number;
  /** Avatars left out of the mirror (too large, not an image, or not downscaled). */
  avatarsOmitted: number;
  bytes: number;
}

export interface RelationshipGraphUploadRequest {
  graph: Record<string, unknown>;
  localVersion: number;
  contentHash: string;
  updatedAt: string;
  avatarsOmitted: number;
}

export interface RelationshipGraphOwnSnapshotResponse {
  snapshot: RelationshipGraphSnapshotMeta | null;
}
