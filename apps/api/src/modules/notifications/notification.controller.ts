import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { NotificationService } from "./notification.service.js";
import { notificationsQuerySchema } from "@connectsphere/shared";

export class NotificationController {
  static async listNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { page, limit, unreadOnly } = notificationsQuerySchema.parse(req.query);
      const result = await NotificationService.listNotifications(
        req.user!.id,
        page,
        limit,
        unreadOnly
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async markAsRead(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const notificationId = req.params.id;
      const updated = await NotificationService.markAsRead(req.user!.id, notificationId);
      res.status(200).json({
        data: updated,
        message: "Notification marked as read",
      });
    } catch (err) {
      next(err);
    }
  }
}
