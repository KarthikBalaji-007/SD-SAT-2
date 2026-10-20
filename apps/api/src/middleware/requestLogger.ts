import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export interface LoggedRequest extends Request {
  requestId?: string;
  startTime?: number;
}

export function requestLogger(req: LoggedRequest, res: Response, next: NextFunction): void {
  req.requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  req.startTime = Date.now();
  res.setHeader("x-request-id", req.requestId);

  res.on("finish", () => {
    const duration = req.startTime ? Date.now() - req.startTime : 0;
    const logData = {
      level: "info",
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
    };
    // Structured JSON log output
    process.stdout.write(JSON.stringify(logData) + "\n");
  });

  next();
}
