import { Router } from "express";
import { NotificationController } from "./notification.controller.js";
import { authMiddleware } from "../../middleware/auth.js";

export const notificationRouter = Router();

// Routes under /api/v1/notifications
notificationRouter.use(authMiddleware);

notificationRouter.get("/", NotificationController.listNotifications);
notificationRouter.patch("/:id/read", NotificationController.markAsRead);
