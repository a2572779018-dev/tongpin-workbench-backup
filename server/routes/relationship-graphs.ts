import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES } from "../../shared/relationshipGraphMirror";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import {
  bossRelationshipGraphResponseBody,
  isRelationshipGraphMemberId,
  parseRelationshipGraphUpload,
  relationshipGraphSnapshotMeta,
  relationshipGraphTenantId,
} from "../relationship-graph-snapshots";
import { JsonStore } from "../store";
import { toPublicUser, type RelationshipGraphSnapshot, type User } from "../types";

type RequireAuth = ReturnType<typeof import("../middleware").createRequireAuth>;

const apiError = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

function noStore(_request: Request, response: Response, next: NextFunction) {
  response.set("Cache-Control", "no-store");
  next();
}

function isListedMember(user: User, tenantId: string): boolean {
  if (user.role !== "member" || user.status !== "active") return false;
  try {
    return relationshipGraphTenantId(user, apiError) === tenantId;
  } catch {
    // Another account with a malformed organization is simply not visible.
    return false;
  }
}

/** Body-parser failures are client errors, not the generic 500 of the global handler. */
function relationshipGraphBodyErrors(
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
) {
  const type = (error as { type?: string } | null)?.type;
  if (type === "entity.too.large") {
    next(apiError(413, "RELATIONSHIP_GRAPH_TOO_LARGE", "客户脉络图超过 5 MB，无法同步给老板"));
    return;
  }
  if (type === "entity.parse.failed") {
    next(apiError(400, "INVALID_JSON", "提交内容不是有效 JSON"));
    return;
  }
  next(error);
}

/**
 * Member side, mounted at /api/relationship-graphs before the global JSON
 * parser. Authentication runs before the larger body is read; a member can
 * only read or replace the snapshot of the authenticated account.
 */
export function createRelationshipGraphsRouter(
  store: JsonStore,
  requireAuth: RequireAuth,
): Router {
  const router = Router();
  router.use(noStore, requireAuth, requireRole("member"));

  router.get("/me", async (request, response, next) => {
    try {
      const userId = request.currentUser!.id;
      const tenantId = relationshipGraphTenantId(request.currentUser, apiError);
      const snapshot = await store.read((database) => {
        const record = database.relationshipGraphSnapshots.find(
          (item) => item.userId === userId && item.tenantId === tenantId,
        );
        return record ? relationshipGraphSnapshotMeta(record) : null;
      });
      response.json({ snapshot });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/me",
    express.json({ limit: RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES }),
    async (request, response, next) => {
      try {
        const userId = request.currentUser!.id;
        const upload = await parseRelationshipGraphUpload(request.body, apiError);
        const snapshot = await store.mutate((database) => {
          const member = database.users.find((user) => user.id === userId);
          if (!member || member.role !== "member" || member.status !== "active") {
            throw apiError(403, "FORBIDDEN", "你没有访问此功能的权限");
          }
          const tenantId = relationshipGraphTenantId(member, apiError);
          const index = database.relationshipGraphSnapshots.findIndex(
            (item) => item.userId === userId,
          );
          const current = index >= 0 ? database.relationshipGraphSnapshots[index] : null;
          const unchanged =
            current?.tenantId === tenantId &&
            current.contentHash === upload.contentHash;
          const next: RelationshipGraphSnapshot = {
            userId,
            tenantId,
            localVersion: upload.localVersion,
            contentHash: upload.contentHash,
            updatedAt: upload.updatedAt,
            syncedAt: new Date().toISOString(),
            contactCount: upload.contactCount,
            connectionCount: upload.connectionCount,
            avatarsOmitted: upload.avatarsOmitted,
            bytes: upload.bytes,
            // Identical content keeps the stored text; only freshness metadata moves.
            graphJson: unchanged ? current.graphJson : upload.serialized,
          };
          if (index >= 0) database.relationshipGraphSnapshots[index] = next;
          else database.relationshipGraphSnapshots.push(next);
          return relationshipGraphSnapshotMeta(next);
        });
        response.json({ snapshot });
      } catch (error) {
        next(error);
      }
    },
  );

  router.use(relationshipGraphBodyErrors);
  return router;
}

/**
 * Boss side, mounted at /api/boss/relationship-graphs. Reuses the Boss-only
 * guard of every other /api/boss route and limits results to the boss's own
 * organization. Read-only: there is no write route here.
 */
export function createBossRelationshipGraphsRouter(
  store: JsonStore,
  requireAuth: RequireAuth,
): Router {
  const router = Router();
  router.use(noStore, requireAuth, requireRole("boss"));

  router.get("/", async (request, response, next) => {
    try {
      const tenantId = relationshipGraphTenantId(request.currentUser, apiError);
      const members = await store.read((database) =>
        database.users
          .filter((user) => isListedMember(user, tenantId))
          .map((user) => {
            const record = database.relationshipGraphSnapshots.find(
              (item) => item.userId === user.id && item.tenantId === tenantId,
            );
            return {
              user: toPublicUser(user),
              snapshot: record ? relationshipGraphSnapshotMeta(record) : null,
            };
          })
          .sort((left, right) =>
            left.user.name.localeCompare(right.user.name, "zh-CN"),
          ),
      );
      response.json({ members });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:userId", async (request, response, next) => {
    try {
      const { userId } = request.params;
      if (typeof userId !== "string" || !isRelationshipGraphMemberId(userId)) {
        throw apiError(404, "USER_NOT_FOUND", "没有找到该成员");
      }
      const tenantId = relationshipGraphTenantId(request.currentUser, apiError);
      const found = await store.read((database) => {
        const user = database.users.find(
          (candidate) => candidate.id === userId && isListedMember(candidate, tenantId),
        );
        if (!user) return null;
        const record = database.relationshipGraphSnapshots.find(
          (item) => item.userId === user.id && item.tenantId === tenantId,
        );
        return { user: toPublicUser(user), record: record ?? null };
      });
      if (!found) throw apiError(404, "USER_NOT_FOUND", "没有找到该成员");
      if (!found.record) {
        throw apiError(404, "RELATIONSHIP_GRAPH_NOT_SYNCED", "该成员尚未同步客户脉络图");
      }
      response
        .type("application/json")
        .send(
          bossRelationshipGraphResponseBody(
            found.user,
            relationshipGraphSnapshotMeta(found.record),
            found.record.graphJson,
          ),
        );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
