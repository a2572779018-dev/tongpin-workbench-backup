const QUICK_TASK_PRIORITIES = new Set(["p0", "p1", "p2", "p3", "p4"]);
const QUICK_TASK_STATUSES = new Set(["todo", "doing", "done"]);

function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function getHotCornerTriggerBounds(workArea, size = 12) {
  return {
    x: workArea.x + workArea.width - size,
    y: workArea.y + workArea.height - size,
    width: size,
    height: size,
  };
}

function getCornerWindowBounds(workArea, size = 54) {
  return {
    x: workArea.x + workArea.width - size,
    y: workArea.y + workArea.height - size,
    width: size,
    height: size,
  };
}

function getQuickPanelBounds(
  workArea,
  preferred = { width: 380, height: 500 },
  margin = 16,
) {
  const width = Math.min(preferred.width, Math.max(320, workArea.width - margin * 2));
  const height = Math.min(
    preferred.height,
    Math.max(380, workArea.height - margin * 2),
  );
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    width,
    height,
  };
}

function expandBounds(bounds, amount) {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function normalizeQuickTaskCommand(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "list-today") return { type: "list-today" };

  if (value.type === "create") {
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (!title || title.length > 120 || !QUICK_TASK_PRIORITIES.has(value.priority)) {
      return null;
    }
    return { type: "create", title, priority: value.priority };
  }

  if (value.type === "update-status") {
    const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        taskId,
      ) ||
      !QUICK_TASK_STATUSES.has(value.status)
    ) {
      return null;
    }
    return { type: "update-status", taskId, status: value.status };
  }

  return null;
}

module.exports = {
  expandBounds,
  getCornerWindowBounds,
  getHotCornerTriggerBounds,
  getQuickPanelBounds,
  normalizeQuickTaskCommand,
  pointInBounds,
};
