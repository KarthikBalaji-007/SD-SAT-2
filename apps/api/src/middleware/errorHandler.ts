import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ApiErrorResponse } from "@connectsphere/shared";
import { LoggedRequest } from "./requestLogger.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Array<{ field?: string; message: string }>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  err: Error,
  req: LoggedRequest,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    const errorResponse: ApiErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    };
    res.status(err.statusCode).json(errorResponse);
    return;
  }

  if (err instanceof ZodError) {
    const errorResponse: ApiErrorResponse = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request payload or parameters",
        details: err.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
        requestId,
      },
    };
    res.status(400).json(errorResponse);
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = Array.isArray(err.meta?.target)
        ? (err.meta?.target as string[]).join(", ")
        : (err.meta?.target as string) || "field";
      const errorResponse: ApiErrorResponse = {
        error: {
          code: "CONFLICT",
          message: `A record with this ${target} already exists`,
          details: [{ field: target, message: "Unique constraint violation" }],
          requestId,
        },
      };
      res.status(409).json(errorResponse);
      return;
    }

    if (err.code === "P2025") {
      const errorResponse: ApiErrorResponse = {
        error: {
          code: "NOT_FOUND",
          message: "The requested record was not found",
          requestId,
        },
      };
      res.status(404).json(errorResponse);
      return;
    }
  }

  // Fallback for unhandled unexpected errors
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        timestamp: new Date().toISOString(),
        requestId,
        message: err.message,
        stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
      }) + "\n"
    );
  }

  const serverErrorResponse: ApiErrorResponse = {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred",
      requestId,
    },
  };
  res.status(500).json(serverErrorResponse);
}
