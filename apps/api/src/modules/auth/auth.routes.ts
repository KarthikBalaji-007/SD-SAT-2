import { Router } from "express";
import { AuthController } from "./auth.controller.js";
import { authMiddleware } from "../../middleware/auth.js";
import { createRateLimiter } from "../../middleware/rateLimiter.js";

export const authRouter = Router();

const registerLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 10,
  prefix: "register",
});

const loginLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 20,
  prefix: "login",
});

authRouter.post("/register", registerLimiter, AuthController.register);
authRouter.post("/login", loginLimiter, AuthController.login);
authRouter.post("/logout", authMiddleware, AuthController.logout);
