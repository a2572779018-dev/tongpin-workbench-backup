import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { businessDateKey } from "../business-date";
import { ApiError } from "../errors";
import { JsonStore } from "../store";
import { appendTaskAudit, taskChanges } from "../task-audit";
import { toPublicUser, type Task } from "../types";
import type { RealtimeHub } from "./boss";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const taskFields = {
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(1000).default(""),
  date: dateSchema,
  status: z.enum(["todo", "doing", "done"]).default("todo"),
  priority: z.enum(["p0", "p1", "p2", "p3", "p4"]).default("p2"),
};

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function createTasksRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  realtime: RealtimeHub,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (request, response, next) => {
    try {
      const { date } = z.object({ date: dateSchema }).parse(request.query);
      const tasks = await store.read((database) =>
        database.tasks
          .filter(
            (task) =>
              task.userId === request.currentUser!.id && task.date === date,
          )
          .sort((a, b) => {
            const statusRank = { doing: 0, todo: 1, done: 2 };
            const priorityRank = { p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 };
            return (
              Number(a.status === "done") - Number(b.status === "done") ||
              priorityRank[a.priority] - priorityRank[b.priority] ||
              statusRank[a.status] - statusRank[b.status] ||
              b.createdAt.localeCompare(a.createdAt)
            );
          }),
      );
      response.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  router.get("/summary", async (request, response, next) => {
    try {
      const { from, to } = z
        .object({ from: dateSchema, to: dateSchema })
        .parse(request.query);
      if (from > to) {
        throw new ApiError(400, "DATE_RANGE_INVALID", "开始日期不能晚于结束日期");
      }
      const numberOfDays =
        Math.floor(
          (Date.parse(`${to}T00:00:00Z`) -
            Date.parse(`${from}T00:00:00Z`)) /
            86_400_000,
        ) + 1;
      if (numberOfDays > 42) {
        throw new ApiError(400, "DATE_RANGE_TOO_LARGE", "一次最多查询 42 天");
      }
      const summary = await store.read((database) => {
        const rows = new Map<string, { total: number; done: number; doing: number }>();
        for (const task of database.tasks) {
          if (
            task.userId !== request.currentUser!.id ||
            task.date < from ||
            task.date > to
          ) {
            continue;
          }
          const row = rows.get(task.date) ?? { total: 0, done: 0, doing: 0 };
          row.total += 1;
          if (task.status === "done") row.done += 1;
          if (task.status === "doing") row.doing += 1;
          rows.set(task.date, row);
        }
        return Object.fromEntries(rows);
      });
      response.json({ summary });
    } catch (error) {
      next(error);
    }
  });

  router.get("/rollover", async (request, response, next) => {
    try {
      const { targetDate } = z
        .object({ targetDate: dateSchema })
        .parse(request.query);
      const userId = request.currentUser!.id;
      const sourceDate = previousDate(targetDate);
      const result = await store.read((database) => {
        const decision = database.taskRolloverDecisions.find(
          (candidate) =>
            candidate.userId === userId &&
            candidate.targetDate === targetDate,
        );
        const tasks = database.tasks
          .filter(
            (task) =>
              task.userId === userId &&
              task.date === sourceDate &&
              task.status !== "done",
          )
          .sort(
            (left, right) =>
              ({ p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 })[left.priority] -
                ({ p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 })[right.priority] ||
              right.createdAt.localeCompare(left.createdAt),
          );
        return {
          sourceDate,
          targetDate,
          pending: !decision && tasks.length > 0,
          decidedAt: decision?.createdAt ?? null,
          tasks,
        };
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/rollover", async (request, response, next) => {
    try {
      const { targetDate, taskIds } = z
        .object({
          targetDate: dateSchema,
          taskIds: z.array(z.string().uuid()).max(100),
        })
        .parse(request.body);
      const userId = request.currentUser!.id;
      const sourceDate = previousDate(targetDate);
      const result = await store.mutate((database) => {
        const existingDecision = database.taskRolloverDecisions.find(
          (candidate) =>
            candidate.userId === userId &&
            candidate.targetDate === targetDate,
        );
        if (existingDecision) {
          return {
            sourceDate,
            targetDate,
            created: database.tasks.filter(
              (task) =>
                task.userId === userId &&
                task.date === targetDate &&
                task.sourceTaskId !== null &&
                existingDecision.selectedTaskIds.includes(task.sourceTaskId),
            ),
            alreadyDecided: true,
          };
        }

        const eligible = database.tasks.filter(
          (task) =>
            task.userId === userId &&
            task.date === sourceDate &&
            task.status !== "done" &&
            taskIds.includes(task.id),
        );
        const now = new Date().toISOString();
        const created: Task[] = [];
        for (const source of eligible) {
          const duplicate = database.tasks.find(
            (task) =>
              task.userId === userId &&
              task.date === targetDate &&
              task.sourceTaskId === source.id,
          );
          if (duplicate) {
            created.push(duplicate);
            continue;
          }
          const task: Task = {
            ...source,
            id: randomUUID(),
            date: targetDate,
            status: "todo",
            origin: "carryover",
            sourceTaskId: source.id,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          database.tasks.push(task);
          appendTaskAudit(
            database,
            task,
            userId,
            "carried_over",
            [
              {
                field: "date",
                before: source.date,
                after: targetDate,
              },
            ],
            now,
          );
          created.push(task);
        }
        database.taskRolloverDecisions.push({
          id: randomUUID(),
          userId,
          sourceDate,
          targetDate,
          selectedTaskIds: eligible.map((task) => task.id),
          createdAt: now,
        });
        return {
          sourceDate,
          targetDate,
          created,
          alreadyDecided: false,
        };
      });
      if (!result.alreadyDecided && result.created.length > 0) {
        realtime.pushUser(userId, "task:batch-changed", {
          tasks: result.created,
          dates: [sourceDate, targetDate],
        });
      }
      response.status(result.alreadyDecided ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/sync-to-today", async (request, response, next) => {
    try {
      const { sourceDate } = z
        .object({ sourceDate: dateSchema })
        .parse(request.query);
      const targetDate = businessDateKey();
      if (sourceDate >= targetDate) {
        throw new ApiError(
          400,
          "PAST_DATE_REQUIRED",
          "只能从往日待办同步到今天",
        );
      }
      const userId = request.currentUser!.id;
      const result = await store.read((database) => {
        const tasks = database.tasks
          .filter(
            (task) =>
              task.userId === userId &&
              task.date === sourceDate &&
              task.status !== "done",
          )
          .sort(
            (left, right) =>
              ({ p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 })[left.priority] -
                ({ p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 })[right.priority] ||
              right.createdAt.localeCompare(left.createdAt),
          );
        const sourceIds = new Set(tasks.map((task) => task.id));
        const syncedTaskIds = database.tasks
          .filter(
            (task) =>
              task.userId === userId &&
              task.date === targetDate &&
              task.sourceTaskId !== null &&
              sourceIds.has(task.sourceTaskId),
          )
          .map((task) => task.sourceTaskId!);
        return { sourceDate, targetDate, tasks, syncedTaskIds };
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sync-to-today", async (request, response, next) => {
    try {
      const { sourceDate, taskIds } = z
        .object({
          sourceDate: dateSchema,
          taskIds: z.array(z.string().uuid()).min(1).max(100),
        })
        .parse(request.body);
      const targetDate = businessDateKey();
      if (sourceDate >= targetDate) {
        throw new ApiError(
          400,
          "PAST_DATE_REQUIRED",
          "只能从往日待办同步到今天",
        );
      }
      const userId = request.currentUser!.id;
      const result = await store.mutate((database) => {
        const eligible = database.tasks.filter(
          (task) =>
            task.userId === userId &&
            task.date === sourceDate &&
            task.status !== "done" &&
            taskIds.includes(task.id),
        );
        const now = new Date().toISOString();
        const created: Task[] = [];
        const skippedTaskIds: string[] = [];
        for (const source of eligible) {
          const duplicate = database.tasks.find(
            (task) =>
              task.userId === userId &&
              task.date === targetDate &&
              task.sourceTaskId === source.id,
          );
          if (duplicate) {
            skippedTaskIds.push(source.id);
            continue;
          }
          const task: Task = {
            ...source,
            id: randomUUID(),
            date: targetDate,
            status: "todo",
            origin: "carryover",
            sourceTaskId: source.id,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          database.tasks.push(task);
          appendTaskAudit(
            database,
            task,
            userId,
            "carried_over",
            [
              {
                field: "date",
                before: source.date,
                after: targetDate,
              },
            ],
            now,
          );
          created.push(task);
        }
        return {
          sourceDate,
          targetDate,
          created,
          skippedTaskIds,
          rejectedTaskIds: taskIds.filter(
            (taskId) => !eligible.some((task) => task.id === taskId),
          ),
        };
      });
      if (result.created.length > 0) {
        realtime.pushUser(userId, "task:batch-changed", {
          tasks: result.created,
          dates: [sourceDate, targetDate],
        });
      }
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/assignments/pending", async (request, response, next) => {
    try {
      const userId = request.currentUser!.id;
      const assignments = await store.read((database) =>
        database.tasks
          .filter(
            (task) =>
              task.userId === userId &&
              task.assignedBy &&
              !task.assignmentViewedAt,
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 20)
          .map((task) => {
            const assigner = database.users.find(
              (user) => user.id === task.assignedBy,
            );
            return assigner
              ? { task, assigner: toPublicUser(assigner) }
              : null;
          })
          .filter((item) => item !== null),
      );
      response.json({ assignments });
    } catch (error) {
      next(error);
    }
  });

  async function markAssignmentReceipt(
    request: Request,
    response: Response,
    next: NextFunction,
    receipt: "delivered" | "viewed",
  ) {
    try {
      const task = await store.mutate((database) => {
        const target = database.tasks.find(
          (candidate) =>
            candidate.id === request.params.taskId &&
            candidate.userId === request.currentUser!.id &&
            candidate.assignedBy,
        );
        if (!target) {
          throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "没有找到该派发任务");
        }
        const now = new Date().toISOString();
        target.assignmentDeliveredAt ??= now;
        if (receipt === "viewed") target.assignmentViewedAt ??= now;
        return structuredClone(target);
      });
      realtime.pushUser(task.assignedBy!, "task:assignment-receipt", {
        task,
        receipt,
      });
      realtime.pushUser(task.userId, "task:changed", { task });
      response.json({ task });
    } catch (error) {
      next(error);
    }
  }

  router.patch("/:taskId/assignment-delivered", (request, response, next) =>
    void markAssignmentReceipt(request, response, next, "delivered"),
  );

  router.patch("/:taskId/assignment-viewed", (request, response, next) =>
    void markAssignmentReceipt(request, response, next, "viewed"),
  );

  router.post("/", async (request, response, next) => {
    try {
      const body = z.object(taskFields).parse(request.body);
      if (body.date < businessDateKey()) {
        throw new ApiError(
          400,
          "PAST_TASK_CREATE_FORBIDDEN",
          "往日待办不能新增，请勾选未完成任务同步到今天",
        );
      }
      const now = new Date().toISOString();
      const task = await store.mutate((database) => {
        const created = {
          id: randomUUID(),
          userId: request.currentUser!.id,
          ...body,
          origin: "self" as const,
          assignedBy: null,
          assignmentId: null,
          sourceTaskId: null,
          assignmentDeliveredAt: null,
          assignmentViewedAt: null,
          completedAt: body.status === "done" ? now : null,
          createdAt: now,
          updatedAt: now,
        };
        database.tasks.push(created);
        appendTaskAudit(
          database,
          created,
          request.currentUser!.id,
          "created",
          [],
          now,
        );
        return created;
      });
      realtime.pushUser(task.userId, "task:changed", { task });
      response.status(201).json({ task });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:taskId", async (request, response, next) => {
    try {
      const body = z
        .object({
          title: taskFields.title.optional(),
          details: z.string().trim().max(1000).optional(),
          date: dateSchema.optional(),
          status: z.enum(["todo", "doing", "done"]).optional(),
          priority: z.enum(["p0", "p1", "p2", "p3", "p4"]).optional(),
        })
        .refine((value) => Object.keys(value).length > 0)
        .parse(request.body);
      const result = await store.mutate((database) => {
        const target = database.tasks.find(
          (candidate) =>
            candidate.id === request.params.taskId &&
            candidate.userId === request.currentUser!.id,
        );
        if (!target) {
          throw new ApiError(404, "TASK_NOT_FOUND", "没有找到该任务");
        }
        if (
          target.assignedBy &&
          (body.title !== undefined ||
            body.date !== undefined ||
            body.priority !== undefined)
        ) {
          throw new ApiError(
            403,
            "ASSIGNED_TASK_LOCKED",
            "老板派发的标题、日期和优先级不能由成员修改",
          );
        }
        if (
          body.date &&
          body.date < businessDateKey() &&
          body.date !== target.date
        ) {
          throw new ApiError(
            400,
            "PAST_TASK_MOVE_FORBIDDEN",
            "不能把任务改到往日日期",
          );
        }
        const before = structuredClone(target);
        const previousStatus = target.status;
        Object.assign(target, body);
        const now = new Date().toISOString();
        if (body.status === "done" && previousStatus !== "done") {
          target.completedAt = now;
        } else if (body.status && body.status !== "done") {
          target.completedAt = null;
        }
        const changes = taskChanges(before, target);
        if (changes.length === 0) {
          return { task: structuredClone(before), changed: false };
        }
        target.updatedAt = now;
        const action =
          before.status !== "done" && target.status === "done"
            ? "completed"
            : before.status === "done" && target.status !== "done"
              ? "reopened"
              : "updated";
        appendTaskAudit(
          database,
          target,
          request.currentUser!.id,
          action,
          changes,
          now,
        );
        return { task: structuredClone(target), changed: true };
      });
      const { task } = result;
      if (result.changed) {
        realtime.pushUser(task.userId, "task:changed", { task });
      }
      if (task.assignedBy) {
        realtime.pushUser(task.assignedBy, "task:status", { task });
      }
      response.json({ task });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:taskId", async (request, response, next) => {
    try {
      const task = await store.mutate((database) => {
        const index = database.tasks.findIndex(
          (candidate) =>
            candidate.id === request.params.taskId &&
            candidate.userId === request.currentUser!.id,
        );
        if (index < 0) {
          throw new ApiError(404, "TASK_NOT_FOUND", "没有找到该任务");
        }
        if (database.tasks[index].assignedBy) {
          throw new ApiError(
            403,
            "ASSIGNED_TASK_LOCKED",
            "老板派发的任务不能由成员删除",
          );
        }
        appendTaskAudit(
          database,
          database.tasks[index],
          request.currentUser!.id,
          "deleted",
        );
        const [deleted] = database.tasks.splice(index, 1);
        return structuredClone(deleted);
      });
      realtime.pushUser(task.userId, "task:deleted", {
        taskId: task.id,
        date: task.date,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
