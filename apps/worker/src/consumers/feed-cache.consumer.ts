import { Channel, ConsumeMessage } from "amqplib";
import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import {
  RABBITMQ_QUEUES,
  EventEnvelope,
  eventEnvelopeSchema,
  EventTypes,
} from "@connectsphere/shared";

export class FeedCacheConsumer {
  private channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    await this.channel.prefetch(10);

    await this.channel.consume(
      RABBITMQ_QUEUES.FEED_CACHE,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        try {
          const raw = msg.content.toString("utf8");
          const data = JSON.parse(raw);
          const envelope: EventEnvelope = eventEnvelopeSchema.parse(data);

          await this.handleEvent(envelope);

          this.channel.ack(msg);
        } catch (err) {
          // Reject to DLX on fatal parsing error, or retry
          this.channel.nack(msg, false, false);
        }
      },
      { noAck: false }
    );
  }

  private async handleEvent(envelope: EventEnvelope): Promise<void> {
    const { eventType, payload } = envelope;

    switch (eventType) {
      case EventTypes.FOLLOW_CREATED:
      case EventTypes.FOLLOW_DELETED: {
        const { followerId } = payload as any;
        if (followerId) {
          await redis.incr(`user:feed_version:${followerId}`);
        }
        break;
      }

      case EventTypes.POST_CREATED:
      case EventTypes.POST_UPDATED:
      case EventTypes.POST_DELETED: {
        const { authorId } = payload as any;
        if (authorId) {
          await this.invalidateAuthorAndFollowers(authorId);
        }
        break;
      }

      case EventTypes.CONTENT_MODERATED: {
        const { targetType, targetId, status, action } = payload as any;
        if (targetType === "POST" && (action === "HIDE_CONTENT" || status === "RESOLVED")) {
          const post = await prisma.post.findUnique({
            where: { id: targetId },
            select: { authorId: true },
          });
          if (post?.authorId) {
            await this.invalidateAuthorAndFollowers(post.authorId);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private async invalidateAuthorAndFollowers(authorId: string): Promise<void> {
    // 1. Invalidate author's own feed
    const pipeline = redis.pipeline();
    pipeline.incr(`user:feed_version:${authorId}`);

    // 2. Invalidate followers' feeds
    const followers = await prisma.follow.findMany({
      where: { followedId: authorId },
      select: { followerId: true },
      take: 2000,
    });

    for (const f of followers) {
      pipeline.incr(`user:feed_version:${f.followerId}`);
    }

    await pipeline.exec();
  }
}
