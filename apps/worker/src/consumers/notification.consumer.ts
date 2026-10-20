import { Channel, ConsumeMessage } from "amqplib";
import { prisma } from "../config/prisma.js";
import { NotificationModel } from "../models/notification.model.js";
import {
  RABBITMQ_QUEUES,
  EventEnvelope,
  eventEnvelopeSchema,
  EventTypes,
} from "@connectsphere/shared";

interface RetryOptions {
  maxRetries?: number;
}

export class NotificationConsumer {
  private channel: Channel;
  private maxRetries: number;

  constructor(channel: Channel, options: RetryOptions = {}) {
    this.channel = channel;
    this.maxRetries = options.maxRetries || 3;
  }

  async start(): Promise<void> {
    await this.channel.prefetch(10);

    await this.channel.consume(
      RABBITMQ_QUEUES.NOTIFICATIONS,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        try {
          const raw = msg.content.toString("utf8");
          const data = JSON.parse(raw);
          const envelope: EventEnvelope = eventEnvelopeSchema.parse(data);

          await this.handleEvent(envelope);

          // Acknowledge after durable processing succeeds
          try {
            this.channel.ack(msg);
          } catch {}
        } catch (err: unknown) {
          const headers = msg.properties.headers || {};
          const retryCount = (headers["x-retry-count"] as number) || 0;

          try {
            if (retryCount < this.maxRetries) {
              // Requeue with incremented retry count
              this.channel.ack(msg);
              this.channel.sendToQueue(RABBITMQ_QUEUES.NOTIFICATIONS, msg.content, {
                ...msg.properties,
                headers: {
                  ...headers,
                  "x-retry-count": retryCount + 1,
                },
              });
            } else {
              // Exceeded retry budget: route to DLX via negative acknowledgement without requeue
              this.channel.nack(msg, false, false);
            }
          } catch {}
        }
      },
      { noAck: false }
    );
  }

  private async handleEvent(envelope: EventEnvelope): Promise<void> {
    const { eventId, eventType, payload } = envelope;

    switch (eventType) {
      case EventTypes.FOLLOW_CREATED: {
        const { followerId, followedId } = payload as any;
        if (!followerId || !followedId || followerId === followedId) return;

        const actor = await prisma.user.findUnique({
          where: { id: followerId },
          select: { username: true, displayName: true },
        });
        if (!actor) return;

        await this.createNotification({
          eventId,
          recipientId: followedId,
          actorId: followerId,
          type: "FOLLOW",
          entityType: "USER",
          entityId: followerId,
          message: `${actor.displayName || actor.username} started following you`,
        });
        break;
      }

      case EventTypes.POST_CREATED: {
        const { postId, authorId } = payload as any;
        if (!postId || !authorId) return;

        const author = await prisma.user.findUnique({
          where: { id: authorId },
          select: { username: true, displayName: true },
        });
        if (!author) return;

        // Bounded fan-out: notify up to 500 active followers
        const followers = await prisma.follow.findMany({
          where: { followedId: authorId },
          select: { followerId: true },
          take: 500,
        });

        if (followers.length === 0) return;

        const docs = followers.map((f) => ({
          eventId,
          recipientId: f.followerId,
          actorId: authorId,
          type: "POST",
          entityType: "POST",
          entityId: postId,
          message: `${author.displayName || author.username} shared a new post`,
        }));

        // Insert ignoring duplicate key errors
        try {
          await NotificationModel.insertMany(docs, { ordered: false });
        } catch (insertErr: any) {
          if (insertErr.code !== 11000 && !insertErr.writeErrors) {
            throw insertErr;
          }
        }
        break;
      }

      case EventTypes.COMMENT_CREATED: {
        const { commentId, postId, postAuthorId, authorId } = payload as any;
        if (!commentId || !postId || !postAuthorId || !authorId) return;
        // Exclude self-comments
        if (authorId === postAuthorId) return;

        const actor = await prisma.user.findUnique({
          where: { id: authorId },
          select: { username: true, displayName: true },
        });
        if (!actor) return;

        await this.createNotification({
          eventId,
          recipientId: postAuthorId,
          actorId: authorId,
          type: "COMMENT",
          entityType: "POST",
          entityId: postId,
          message: `${actor.displayName || actor.username} commented on your post`,
        });

        break;
      }

      case EventTypes.REACTION_CREATED: {
        const { reactionId, postId, postAuthorId, userId } = payload as any;
        if (!reactionId || !postId || !postAuthorId || !userId) return;
        // Exclude self-reactions
        if (userId === postAuthorId) return;

        const actor = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true },
        });
        if (!actor) return;

        await this.createNotification({
          eventId,
          recipientId: postAuthorId,
          actorId: userId,
          type: "REACTION",
          entityType: "POST",
          entityId: postId,
          message: `${actor.displayName || actor.username} reacted to your post`,
        });
        break;
      }

      case EventTypes.CONTENT_MODERATED: {
        const { targetType, targetId, status, action } = payload as any;
        if (status === "RESOLVED" && action === "HIDE_CONTENT") {
          let authorId: string | null = null;
          if (targetType === "POST") {
            const post = await prisma.post.findUnique({
              where: { id: targetId },
              select: { authorId: true },
            });
            authorId = post?.authorId || null;
          } else if (targetType === "COMMENT") {
            const comment = await prisma.comment.findUnique({
              where: { id: targetId },
              select: { authorId: true },
            });
            authorId = comment?.authorId || null;
          }

          if (authorId) {
            await this.createNotification({
              eventId,
              recipientId: authorId,
              actorId: "SYSTEM",
              type: "MODERATION",
              entityType: targetType,
              entityId: targetId,
              message: "Your content was reviewed and hidden due to a community guidelines violation.",
            });
          }
        }
        break;
      }

      case EventTypes.MESSAGE_SENT: {
        const { messageId, conversationId, senderId, recipientId } = payload as any;
        if (!messageId || !conversationId || !senderId || !recipientId) return;
        // Suppress self-notifications
        if (senderId === recipientId) return;

        const sender = await prisma.user.findUnique({
          where: { id: senderId },
          select: { username: true, displayName: true },
        });
        if (!sender) return;

        await this.createNotification({
          eventId,
          recipientId,
          actorId: senderId,
          type: "MESSAGE",
          entityType: "CONVERSATION",
          entityId: conversationId,
          message: `${sender.displayName || sender.username} sent you a message`,
        });
        break;
      }

      default:
        // Other events do not generate user notifications
        break;
    }
  }

  private async createNotification(doc: {
    eventId: string;
    recipientId: string;
    actorId: string;
    type: string;
    entityType: string;
    entityId: string;
    message: string;
  }): Promise<void> {
    try {
      await NotificationModel.create(doc);
    } catch (err: any) {
      // MongoDB duplicate key error code 11000: idempotently ignore
      if (err.code === 11000) {
        return;
      }
      throw err;
    }
  }
}
