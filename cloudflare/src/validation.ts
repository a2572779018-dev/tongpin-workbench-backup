import type {
  TaskPriority,
  TaskStatus,
  UserRole,
  VerificationPurpose,
} from "../../server/types";
import { ApiError } from "./platform";

type JsonObject = Record<string, unknown>;

function invalid(message = "提交的内容格式不正确"): never {
  throw new ApiError(400, "VALIDATION_ERROR", message);
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  return value as JsonObject;
}

function stringValue(
  value: unknown,
  options: {
    name: string;
    min?: number;
    max: number;
    trim?: boolean;
  },
): string {
  if (typeof value !== "string") return invalid(`${options.name}格式不正确`);
  const result = options.trim === false ? value : value.trim();
  if (
    result.length < (options.min ?? 0) ||
    result.length > options.max
  ) {
    return invalid(`${options.name}长度不正确`);
  }
  return result;
}

function optionalString(
  value: unknown,
  options: { name: string; min?: number; max: number },
): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, options);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return invalid(`${name}不正确`);
  }
  return value as T;
}

function emailValue(value: unknown): string {
  const email = stringValue(value, { name: "邮箱", min: 3, max: 200 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return invalid("邮箱格式不正确");
  }
  return email;
}

function passwordValue(value: unknown): string {
  const password = stringValue(value, {
    name: "密码",
    min: 8,
    max: 100,
    trim: false,
  });
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return invalid("密码至少需要包含一个字母和一个数字");
  }
  return password;
}

function dateValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    return invalid("日期格式不正确");
  }
  return value;
}

function uuidValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return invalid("成员编号格式不正确");
  }
  return value;
}

export function parseRegister(value: unknown): {
  email: string;
  name: string;
  password: string;
} {
  const body = objectValue(value);
  return {
    email: emailValue(body.email),
    name: stringValue(body.name, { name: "姓名", min: 2, max: 30 }),
    password: passwordValue(body.password),
  };
}

export function parseVerification(value: unknown): {
  email: string;
  code: string;
} {
  const body = objectValue(value);
  const code = stringValue(body.code, {
    name: "验证码",
    min: 6,
    max: 6,
    trim: false,
  });
  if (!/^\d{6}$/.test(code)) return invalid("验证码格式不正确");
  return { email: emailValue(body.email), code };
}

export function parseLogin(value: unknown): {
  email: string;
  password: string;
} {
  const body = objectValue(value);
  return {
    email: emailValue(body.email),
    password: stringValue(body.password, {
      name: "密码",
      min: 1,
      max: 100,
      trim: false,
    }),
  };
}

export function parseResetPassword(value: unknown): {
  email: string;
  code: string;
  password: string;
} {
  const verified = parseVerification(value);
  const body = objectValue(value);
  return { ...verified, password: passwordValue(body.password) };
}

export function parseResend(value: unknown): {
  email: string;
  purpose: VerificationPurpose;
} {
  const body = objectValue(value);
  return {
    email: emailValue(body.email),
    purpose: enumValue(
      body.purpose,
      ["register", "reset_password"] as const,
      "验证码用途",
    ),
  };
}

export function parseRefreshToken(value: unknown): string {
  const body = objectValue(value);
  return stringValue(body.refreshToken, {
    name: "刷新令牌",
    min: 20,
    max: 500,
    trim: false,
  });
}

export function parseEmail(value: unknown): string {
  return emailValue(objectValue(value).email);
}

export function parseAvatar(value: unknown): string | null {
  const body = objectValue(value);
  if (body.dataUrl === null) return null;
  return stringValue(body.dataUrl, {
    name: "头像",
    max: 700_000,
    trim: false,
  });
}

export function parseDate(value: unknown): string {
  return dateValue(value);
}

export function parseTaskCreate(value: unknown): {
  title: string;
  details: string;
  date: string;
  status: TaskStatus;
  priority: TaskPriority;
  scope: "day" | "rest_of_week";
} {
  const body = objectValue(value);
  return {
    title: stringValue(body.title, {
      name: "任务标题",
      min: 1,
      max: 120,
    }),
    details:
      optionalString(body.details, {
        name: "任务详情",
        max: 1_000,
      }) ?? "",
    date: dateValue(body.date),
    status:
      body.status === undefined
        ? "todo"
        : enumValue(
            body.status,
            ["todo", "doing", "done"] as const,
            "任务状态",
          ),
    priority:
      body.priority === undefined
        ? "p2"
        : enumValue(
            body.priority,
            ["p0", "p1", "p2", "p3", "p4"] as const,
            "任务优先级",
          ),
    scope:
      body.scope === undefined
        ? "day"
        : enumValue(
            body.scope,
            ["day", "rest_of_week"] as const,
            "任务创建范围",
          ),
  };
}

export function parseTaskPatch(value: unknown): {
  title?: string;
  details?: string;
  date?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
} {
  const body = objectValue(value);
  const parsed = {
    title: optionalString(body.title, {
      name: "任务标题",
      min: 1,
      max: 120,
    }),
    details: optionalString(body.details, {
      name: "任务详情",
      max: 1_000,
    }),
    date: body.date === undefined ? undefined : dateValue(body.date),
    status:
      body.status === undefined
        ? undefined
        : enumValue(
            body.status,
            ["todo", "doing", "done"] as const,
            "任务状态",
          ),
    priority:
      body.priority === undefined
        ? undefined
        : enumValue(
            body.priority,
            ["p0", "p1", "p2", "p3", "p4"] as const,
            "任务优先级",
          ),
  };
  if (Object.values(parsed).every((item) => item === undefined)) {
    return invalid("没有可更新的任务内容");
  }
  return parsed;
}

export function parseAccessStatus(value: unknown): "active" | "disabled" {
  return enumValue(
    objectValue(value).status,
    ["active", "disabled"] as const,
    "账号状态",
  );
}

export function parseRole(value: unknown): Exclude<UserRole, "admin"> {
  return enumValue(
    objectValue(value).role,
    ["member", "boss"] as const,
    "账号角色",
  );
}

export function parseNotificationRequest(value: unknown): {
  all: boolean;
  recipientIds: string[];
  title: string;
  body: string;
} {
  const input = objectValue(value);
  const all = input.all === undefined ? false : input.all;
  if (typeof all !== "boolean") return invalid("通知范围不正确");
  const rawRecipientIds =
    input.recipientIds === undefined ? [] : input.recipientIds;
  if (!Array.isArray(rawRecipientIds) || rawRecipientIds.length > 100) {
    return invalid("接收成员数量不正确");
  }
  const recipientIds = rawRecipientIds.map(uuidValue);
  if (!all && recipientIds.length === 0) {
    return invalid("请选择至少一位接收成员");
  }
  return {
    all,
    recipientIds,
    title: stringValue(input.title, {
      name: "通知标题",
      min: 1,
      max: 50,
    }),
    body: stringValue(input.body, {
      name: "通知内容",
      min: 1,
      max: 300,
    }),
  };
}

export function parseContactRequest(value: unknown): string {
  return uuidValue(objectValue(value).userId);
}

export function parseDirectMessage(value: unknown): {
  body: string;
  mode: "normal" | "flash";
} {
  const input = objectValue(value);
  return {
    body: stringValue(input.body, {
      name: "消息内容",
      min: 1,
      max: 500,
    }),
    mode:
      input.mode === undefined
        ? "normal"
        : enumValue(
            input.mode,
            ["normal", "flash"] as const,
            "消息模式",
          ),
  };
}

export function parseContactSearch(value: unknown): string {
  return stringValue(value, {
    name: "搜索姓名",
    min: 1,
    max: 30,
  });
}

export function parseJobTitle(value: unknown): string {
  return stringValue(objectValue(value).jobTitle, {
    name: "职位",
    max: 30,
  });
}

export function parseTaskAssignment(value: unknown): {
  title: string;
  details: string;
  date: string;
  priority: TaskPriority;
} {
  const task = parseTaskCreate(value);
  return {
    title: task.title,
    details: task.details,
    date: task.date,
    priority: task.priority,
  };
}

export function parseTaskRollover(value: unknown): {
  targetDate: string;
  taskIds: string[];
} {
  const input = objectValue(value);
  if (!Array.isArray(input.taskIds) || input.taskIds.length > 100) {
    return invalid("承接任务数量不正确");
  }
  return {
    targetDate: dateValue(input.targetDate),
    taskIds: input.taskIds.map(uuidValue),
  };
}

export function parseTaskSync(value: unknown): {
  sourceDate: string;
  taskIds: string[];
} {
  const input = objectValue(value);
  if (
    !Array.isArray(input.taskIds) ||
    input.taskIds.length < 1 ||
    input.taskIds.length > 100
  ) {
    return invalid("请选择 1 至 100 项未完成任务");
  }
  return {
    sourceDate: dateValue(input.sourceDate),
    taskIds: input.taskIds.map(uuidValue),
  };
}
