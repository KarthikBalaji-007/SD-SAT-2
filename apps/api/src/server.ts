import http from "http";
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config/env.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { getReadinessReport } from "./services/health.js";
import { HealthCheckResponse } from "@connectsphere/shared";
import { authRouter } from "./modules/auth/auth.routes.js";
import { userRouter } from "./modules/users/user.routes.js";
import { postRouter, feedRouter } from "./modules/posts/post.routes.js";
import { commentDirectRouter } from "./modules/comments/comment.routes.js";
import { reportRouter } from "./modules/reports/report.routes.js";
import { moderationRouter } from "./modules/moderation/moderation.routes.js";
import { notificationRouter } from "./modules/notifications/notification.routes.js";
import { conversationRouter, messageDirectRouter } from "./modules/messages/message.routes.js";
import { initSocketServer, getSocketServer } from "./socket/index.js";

export const app = express();
export const httpServer = http.createServer(app);
export const io = initSocketServer(httpServer);

// Security and middleware
app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
app.use(requestLogger);

// Liveness check: proves process is responsive
app.get("/health/live", (_req: Request, res: Response) => {
  const response: HealthCheckResponse = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime() * 100) / 100,
  };
  res.status(200).json(response);
});

// Readiness check: probes critical external dependencies
app.get("/health/ready", async (_req: Request, res: Response) => {
  const { report, statusCode } = await getReadinessReport();
  res.status(statusCode).json(report);
});

// API root welcome / index
app.get("/api/v1", (_req: Request, res: Response) => {
  res.status(200).json({
    name: "ConnectSphere API",
    version: "1.0.0",
    status: "online",
    documentation: "/API.md",
  });
});

// Mount API v1 modules
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/posts", postRouter);
app.use("/api/v1/feed", feedRouter);
app.use("/api/v1/comments", commentDirectRouter);
app.use("/api/v1/reports", reportRouter);
app.use("/api/v1/moderation", moderationRouter);
app.use("/api/v1/notifications", notificationRouter);
app.use("/api/v1/conversations", conversationRouter);
app.use("/api/v1/messages", messageDirectRouter);

// Global error handler
app.use(errorHandler);

let server: http.Server | null = null;

export function startServer(port = config.PORT) {
  server = httpServer.listen(port, () => {
    process.stdout.write(
      JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        message: `ConnectSphere API listening on http://localhost:${port}`,
        env: config.NODE_ENV,
      }) + "\n"
    );
  });
  return server;
}

// Graceful shutdown handling
function gracefulShutdown(signal: string) {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message: `Received ${signal}, commencing graceful shutdown`,
    }) + "\n"
  );

  if (server) {
    server.close(() => {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          timestamp: new Date().toISOString(),
          message: "HTTP server closed, exiting process",
        }) + "\n"
      );
      process.exit(0);
    });

    // Force shutdown after 10s timeout
    setTimeout(() => {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          timestamp: new Date().toISOString(),
          message: "Graceful shutdown timed out, force terminating",
        }) + "\n"
      );
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start server when executed directly
if (process.env.NODE_ENV !== "test") {
  startServer();
}
