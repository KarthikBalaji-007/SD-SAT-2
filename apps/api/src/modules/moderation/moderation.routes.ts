import { Router } from "express";
import { ModerationController } from "./moderation.controller.js";
import { authMiddleware, requireRole } from "../../middleware/auth.js";

export const moderationRouter = Router();

// All moderation routes require authenticated user with MODERATOR or ADMIN role
moderationRouter.use(authMiddleware, requireRole("MODERATOR", "ADMIN"));

moderationRouter.get("/reports", ModerationController.listReports);
moderationRouter.patch("/reports/:reportId", ModerationController.resolveReport);
