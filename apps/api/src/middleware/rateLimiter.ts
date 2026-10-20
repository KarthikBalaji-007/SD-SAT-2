import { Request, Response, NextFunction } from "express";
import { redis } from "../config/redis.js";
import { AppError } from "./errorHandler.js";

interface InMemoryRecord {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, InMemoryRecord>();

export function createRateLimiter(options: {
  windowSeconds: number;
  maxRequests: number;
  prefix: string;
}) {
  const { windowSeconds, maxRequests, prefix } = options;

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // Skip rate limiting in test environment unless explicitly desired
    if (process.env.NODE_ENV === "test") {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
    const key = `ratelimit:${prefix}:${ip}`;

    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      if (current > maxRequests) {
        return next(
          new AppError(
            429,
            "TOO_MANY_REQUESTS",
            `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowSeconds} seconds.`
          )
        );
      }

      next();
    } catch {
      // Graceful fallback to memory store if Redis is unavailable
      const now = Date.now();
      const memRecord = memoryStore.get(key);

      if (!memRecord || now > memRecord.resetAt) {
        memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return next();
      }

      memRecord.count += 1;
      if (memRecord.count > maxRequests) {
        return next(
          new AppError(
            429,
            "TOO_MANY_REQUESTS",
            `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowSeconds} seconds.`
          )
        );
      }

      next();
    }
  };
}
