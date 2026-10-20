import pg from "pg";
import mongoose from "mongoose";
import { Redis } from "ioredis";
import amqp from "amqplib";
import { config } from "../config/env.js";
import {
  HealthCheckResponse,
  DependencyHealth,
  HealthStatus,
} from "@connectsphere/shared";

const TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, serviceName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${serviceName} probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function checkPostgres(): Promise<DependencyHealth> {
  const start = Date.now();
  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: TIMEOUT_MS,
  });

  try {
    await withTimeout(client.connect(), TIMEOUT_MS, "PostgreSQL");
    await withTimeout(client.query("SELECT 1;"), TIMEOUT_MS, "PostgreSQL query");
    await client.end().catch(() => {});
    return {
      status: "up",
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    await client.end().catch(() => {});
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Failed to connect to PostgreSQL",
    };
  }
}

export async function checkMongoDB(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const conn = await withTimeout(
      mongoose.createConnection(config.MONGODB_URI, {
        serverSelectionTimeoutMS: TIMEOUT_MS,
        connectTimeoutMS: TIMEOUT_MS,
      }).asPromise(),
      TIMEOUT_MS + 200,
      "MongoDB"
    );

    if (conn.db) {
      await withTimeout(conn.db.admin().ping(), TIMEOUT_MS, "MongoDB ping");
    }
    await conn.close().catch(() => {});

    return {
      status: "up",
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Failed to connect to MongoDB",
    };
  }
}

export async function checkRedis(): Promise<DependencyHealth> {
  const start = Date.now();
  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null, // do not retry during probe
    lazyConnect: true,
  });

  try {
    await withTimeout(redis.connect(), TIMEOUT_MS, "Redis connect");
    await withTimeout(redis.ping(), TIMEOUT_MS, "Redis ping");
    await redis.quit().catch(() => redis.disconnect());
    return {
      status: "up",
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    redis.disconnect();
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Failed to connect to Redis",
    };
  }
}

export async function checkRabbitMQ(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const conn = await withTimeout(
      amqp.connect(config.RABBITMQ_URL, { timeout: TIMEOUT_MS }),
      TIMEOUT_MS,
      "RabbitMQ"
    );
    await conn.close().catch(() => {});
    return {
      status: "up",
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      message: err instanceof Error ? err.message : "Failed to connect to RabbitMQ",
    };
  }
}

export async function getReadinessReport(): Promise<{
  report: HealthCheckResponse;
  statusCode: number;
}> {
  const [postgres, mongodb, redis, rabbitmq] = await Promise.all([
    checkPostgres(),
    checkMongoDB(),
    checkRedis(),
    checkRabbitMQ(),
  ]);

  const allUp =
    postgres.status === "up" &&
    mongodb.status === "up" &&
    redis.status === "up" &&
    rabbitmq.status === "up";

  const overallStatus: HealthStatus = allUp ? "healthy" : "unhealthy";

  const report: HealthCheckResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime() * 100) / 100,
    services: {
      postgres,
      mongodb,
      redis,
      rabbitmq,
    },
  };

  return {
    report,
    statusCode: allUp ? 200 : 503,
  };
}
