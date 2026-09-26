const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDesktopNoticeAction(action) {
  if (!action || typeof action !== "object") return null;
  if (
    action.type === "open-task" &&
    typeof action.taskId === "string" &&
    action.taskId.trim() &&
    typeof action.date === "string" &&
    REPORT_DATE_PATTERN.test(action.date)
  ) {
    return {
      type: "open-task",
      taskId: action.taskId.trim().slice(0, 80),
      date: action.date,
    };
  }
  if (
    action.type === "open-lora-dashboard" &&
    typeof action.reportDate === "string" &&
    REPORT_DATE_PATTERN.test(action.reportDate)
  ) {
    return {
      type: "open-lora-dashboard",
      reportDate: action.reportDate,
    };
  }
  if (action.type === "open-admin-ai-monitoring") {
    return { type: "open-admin-ai-monitoring" };
  }
  return null;
}

module.exports = { normalizeDesktopNoticeAction, REPORT_DATE_PATTERN };

