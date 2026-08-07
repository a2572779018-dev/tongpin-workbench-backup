import { randomUUID } from "node:crypto";
import type {
  DatabaseShape,
  Task,
  TaskAuditAction,
  TaskAuditChange,
  TaskAuditEvent,
  TaskAuditField,
} from "./types";

const AUDITED_FIELDS: TaskAuditField[] = [
  "title",
  "details",
  "date",
  "priority",
  "status",
];

export function taskChanges(before: Task, after: Task): TaskAuditChange[] {
  return AUDITED_FIELDS.flatMap((field) =>
    before[field] === after[field]
      ? []
      : [
          {
            field,
            before: before[field],
            after: after[field],
          },
        ],
  );
}

export function appendTaskAudit(
  database: DatabaseShape,
  task: Task,
  actorId: string,
  action: TaskAuditAction,
  changes: TaskAuditChange[] = [],
  createdAt = new Date().toISOString(),
): TaskAuditEvent {
  const event: TaskAuditEvent = {
    id: randomUUID(),
    taskId: task.id,
    userId: task.userId,
    actorId,
    action,
    changes,
    snapshot: structuredClone(task),
    createdAt,
  };
  database.taskAuditEvents.push(event);
  return event;
}
