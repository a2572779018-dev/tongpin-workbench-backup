import type { RelationshipGraphSnapshotMeta } from "../../shared/relationshipGraphMirror";
import type { User } from "../types";

export interface BossRelationshipGraphMember {
  user: User;
  snapshot: RelationshipGraphSnapshotMeta | null;
}

export interface BossRelationshipGraphDetail {
  user: User;
  snapshot: RelationshipGraphSnapshotMeta;
  graph: unknown;
}

/** Synced members first (most recent sync on top), then 未同步 members by name. */
export function sortBossRelationshipGraphMembers(
  members: readonly BossRelationshipGraphMember[],
): BossRelationshipGraphMember[] {
  return [...members].sort((left, right) => {
    if (left.snapshot && right.snapshot) {
      return (
        right.snapshot.syncedAt.localeCompare(left.snapshot.syncedAt) ||
        left.user.name.localeCompare(right.user.name, "zh-CN")
      );
    }
    if (left.snapshot) return -1;
    if (right.snapshot) return 1;
    return left.user.name.localeCompare(right.user.name, "zh-CN");
  });
}

export function summarizeBossRelationshipGraphs(
  members: readonly BossRelationshipGraphMember[],
): { people: number; synced: number; unsynced: number; contacts: number } {
  const synced = members.filter((member) => member.snapshot);
  return {
    people: members.length,
    synced: synced.length,
    unsynced: members.length - synced.length,
    contacts: synced.reduce((sum, member) => sum + (member.snapshot?.contactCount ?? 0), 0),
  };
}

export function formatRelationshipGraphSyncedAt(iso: string, nowMs = Date.now()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${sameYear ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** A desktop client can be updated before the backend; say so instead of a bare 404. */
export function bossRelationshipGraphErrorMessage(error: unknown, fallback: string): string {
  const details =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown; message?: unknown })
      : {};
  if (details.status === 404 && details.code === "NOT_FOUND") {
    return "服务器暂未开放成员客户脉络图，请更新后端后再试";
  }
  return typeof details.message === "string" && details.message ? details.message : fallback;
}

/** One line shown with a snapshot in the boss viewer (sync time, read-only, avatars). */
export function bossRelationshipGraphNote(
  snapshot: RelationshipGraphSnapshotMeta,
  nowMs = Date.now(),
): string {
  const parts = [`同步于 ${formatRelationshipGraphSyncedAt(snapshot.syncedAt, nowMs)}`];
  if (snapshot.avatarsOmitted > 0) {
    parts.push(`${snapshot.avatarsOmitted} 个头像未同步，以姓名首字显示`);
  }
  return parts.join(" · ");
}
