import { Router } from "express";
import { z } from "zod";
import type { LoraChainCollector } from "../lora-chain/collector";
import { dashboardFromDatabase } from "../lora-chain/collector";
import { shanghaiDateKey } from "../lora-chain/time";
import { requireRole } from "../middleware";
import type { JsonStore } from "../store";

const claimSchema = z.object({
  trigger: z
    .enum(["startup", "login", "08:00", "reconnect", "manual"])
    .default("startup"),
});

export function createLoraChainRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  collector: LoraChainCollector,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("boss", "admin"));

  router.get("/dashboard", async (_request, response, next) => {
    try {
      const dashboard = await store.read((database) =>
        dashboardFromDatabase(database),
      );
      response.json(dashboard);
    } catch (error) {
      next(error);
    }
  });

  router.post("/refresh", async (_request, response, next) => {
    try {
      void collector.refresh().catch(() => undefined);
      const dashboard = await store.read((database) =>
        dashboardFromDatabase(database),
      );
      response.status(202).json({ accepted: true, dashboard });
    } catch (error) {
      next(error);
    }
  });

  router.post("/daily-popup/claim", async (request, response, next) => {
    try {
      const { trigger } = claimSchema.parse(request.body ?? {});
      const reportDate = shanghaiDateKey();
      if (request.currentUser!.role === "admin" || trigger === "manual") {
        const dashboard = await store.read((database) =>
          dashboardFromDatabase(database),
        );
        response.json({ shouldOpen: false, reportDate, dashboard });
        return;
      }
      const claimedAt = new Date().toISOString();
      const result = await store.mutate((database) => {
        const existing = database.bossLoraReportOpens.find(
          (claim) =>
            claim.bossUserId === request.currentUser!.id &&
            claim.reportDate === reportDate,
        );
        if (existing) {
          return {
            shouldOpen: false,
            claimedAt: existing.claimedAt,
            dashboard: dashboardFromDatabase(database),
          };
        }
        database.bossLoraReportOpens.push({
          bossUserId: request.currentUser!.id,
          reportDate,
          claimedAt,
          trigger,
        });
        return {
          shouldOpen: true,
          claimedAt,
          dashboard: dashboardFromDatabase(database),
        };
      });
      response.json({ reportDate, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
