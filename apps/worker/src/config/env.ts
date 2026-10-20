import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  RABBITMQ_URL: z.string().default("amqp://guest:guest@localhost:5672"),
  DATABASE_URL: z.string().default("postgresql://connectsphere_user:connectsphere_dev_password@localhost:5432/connectsphere_db?schema=public"),
  MONGODB_URI: z.string().default("mongodb://root:mongo_dev_password@localhost:27017/connectsphere_chat?authSource=admin"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MAX_RECONNECT_ATTEMPTS: z.coerce.number().default(10),
  INITIAL_RECONNECT_DELAY_MS: z.coerce.number().default(1000),
  MAX_RECONNECT_DELAY_MS: z.coerce.number().default(15000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(50),
  FEED_CACHE_TTL_SECONDS: z.coerce.number().default(60),
});

export const config = workerEnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  RABBITMQ_URL: process.env.RABBITMQ_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL,
  MAX_RECONNECT_ATTEMPTS: process.env.MAX_RECONNECT_ATTEMPTS,
  INITIAL_RECONNECT_DELAY_MS: process.env.INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS: process.env.MAX_RECONNECT_DELAY_MS,
  OUTBOX_POLL_INTERVAL_MS: process.env.OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_BATCH_SIZE: process.env.OUTBOX_BATCH_SIZE,
  FEED_CACHE_TTL_SECONDS: process.env.FEED_CACHE_TTL_SECONDS,
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

