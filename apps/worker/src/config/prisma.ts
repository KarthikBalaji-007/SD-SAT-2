import { PrismaClient } from "@prisma/client";
import { config } from "./env.js";

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.DATABASE_URL,
    },
  },
  log: config.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});
