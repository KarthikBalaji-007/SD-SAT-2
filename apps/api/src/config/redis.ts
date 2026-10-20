import { Redis } from "ioredis";
import { config } from "./env.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    return Math.min(times * 100, 3000);
  },
  lazyConnect: false,
});

redis.on("error", (err) => {
  // Avoid uncaught exception, structured log
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        timestamp: new Date().toISOString(),
        service: "redis",
        message: err.message,
      }) + "\n"
    );
  }
});
