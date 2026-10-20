import mongoose from "mongoose";
import { prisma } from "../../config/prisma.js";
import { connectMongo } from "../../config/mongo.js";
import { NotificationModel } from "../../models/notification.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  NotificationResponse,
  NotificationsListResponse,
} from "@connectsphere/shared";

export class NotificationService {
  /**
   * List paginated notifications for the authenticated user
   */
  static async listNotifications(
    recipientId: string,
    page = 1,
    limit = 20,
    unreadOnly = false
  ): Promise<NotificationsListResponse> {
    await connectMongo();

    const filter: Record<string, unknown> = { recipientId };
    if (unreadOnly) {
      filter.readAt = null;
    }

    const skip = (page - 1) * limit;

    const [total, unreadCount, docs] = await Promise.all([
      NotificationModel.countDocuments(filter),
      NotificationModel.countDocuments({ recipientId, readAt: null }),
      NotificationModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Retrieve author summaries for actors from PostgreSQL
    const actorIds = [
      ...new Set(
        docs.map((d) => d.actorId).filter((id) => id && id !== "SYSTEM")
      ),
    ];

    const actors =
      actorIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          })
        : [];

    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const data: NotificationResponse[] = docs.map((d) => ({
      id: d._id.toString(),
      eventId: d.eventId,
      recipientId: d.recipientId,
      actorId: d.actorId,
      actor: actorMap.get(d.actorId) || undefined,
      type: d.type,
      entityType: d.entityType,
      entityId: d.entityId,
      message: d.message,
      readAt: d.readAt ? new Date(d.readAt).toISOString() : null,
      createdAt: new Date(d.createdAt).toISOString(),
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        unreadCount,
        hasMore: skip + docs.length < total,
      },
    };
  }

  /**
   * Mark an owned notification as read
   */
  static async markAsRead(
    recipientId: string,
    notificationId: string
  ): Promise<NotificationResponse> {
    await connectMongo();

    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      throw new AppError(404, "NOT_FOUND", "Notification not found");
    }

    const notif = await NotificationModel.findOne({
      _id: notificationId,
      recipientId,
    });

    if (!notif) {
      throw new AppError(404, "NOT_FOUND", "Notification not found");
    }

    if (!notif.readAt) {
      notif.readAt = new Date();
      await notif.save();
    }

    return {
      id: notif._id.toString(),
      eventId: notif.eventId,
      recipientId: notif.recipientId,
      actorId: notif.actorId,
      type: notif.type,
      entityType: notif.entityType,
      entityId: notif.entityId,
      message: notif.message,
      readAt: notif.readAt.toISOString(),
      createdAt: notif.createdAt.toISOString(),
    };
  }
}
