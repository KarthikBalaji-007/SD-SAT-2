import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PORT: z.coerce.number().optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().default("postgresql://connectsphere_user:connectsphere_dev_password@localhost:5432/connectsphere_db?schema=public"),
  MONGODB_URI: z.string().default("mongodb://root:mongo_dev_password@localhost:27017/connectsphere_chat?authSource=admin"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  RABBITMQ_URL: z.string().default("amqp://guest:guest@localhost:5672"),
  JWT_SECRET: z.string().default("dev_jwt_secret_key_minimum_32_characters_long_for_connectsphere"),
});

export const config = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT || process.env.API_PORT || 4000,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  DATABASE_URL: process.env.DATABASE_URL,
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL,
  RABBITMQ_URL: process.env.RABBITMQ_URL,
  JWT_SECRET: process.env.JWT_SECRET,
});

export type Config = z.infer<typeof envSchema>;
