import type { NextFunction, Request, Response } from "express";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFoundHandler(
  _request: Request,
  response: Response,
): void {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "请求的接口不存在",
    },
  });
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ZodError"
  ) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "提交的内容格式不正确",
      },
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "服务器处理失败，请稍后重试",
    },
  });
}
