import amqp, { ConfirmChannel } from "amqplib";
import { MessageModel, IMessage } from "./models/message.model.js";
import {
  RABBITMQ_EXCHANGE,
  EventEnvelope,
  eventEnvelopeSchema,
  EventTypes,
} from "@connectsphere/shared";

function publishWithConfirm(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: amqp.Options.Publish
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.publish(exchange, routingKey, content, options, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export class MessageDispatcher {
  private channel: ConfirmChannel;
  private isRunning = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private batchSize: number;
  private pollIntervalMs: number;

  constructor(
    channel: ConfirmChannel,
    options: { batchSize?: number; pollIntervalMs?: number } = {}
  ) {
    this.channel = channel;
    this.batchSize = options.batchSize || 50;
    this.pollIntervalMs = options.pollIntervalMs || 500;
  }

  /**
   * Process a single batch of pending MongoDB message publication events.
   * Atomically claims documents using findOneAndUpdate leases to prevent
   * duplicate dispatch across multiple worker instances.
   */
  async processBatch(): Promise<number> {
    const claimLeaseMs = 30000;
    const now = new Date();
    const leaseExpiry = new Date(Date.now() + claimLeaseMs);

    // 1. Find candidate unpublished messages
    const candidates = await MessageModel.find({
      "publication.publishedAt": null,
      $or: [
        { "publication.retryAfter": null },
        { "publication.retryAfter": { $lte: now } },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(this.batchSize)
      .select("_id")
      .lean();

    if (candidates.length === 0) {
      return 0;
    }

    let processedCount = 0;

    for (const candidate of candidates) {
      // 2. Atomically claim document with a lease window
      const claimed: IMessage | null = await MessageModel.findOneAndUpdate(
        {
          _id: candidate._id,
          "publication.publishedAt": null,
          $or: [
            { "publication.retryAfter": null },
            { "publication.retryAfter": { $lte: now } },
          ],
        },
        {
          $set: {
            "publication.retryAfter": leaseExpiry,
            "publication.lastAttemptAt": new Date(),
          },
        },
        { new: true }
      );

      if (!claimed) {
        // Concurrently claimed by another worker instance
        continue;
      }

      processedCount++;

      try {
        const envelope: EventEnvelope = {
          eventId: claimed.publication.eventId,
          eventType: EventTypes.MESSAGE_SENT,
          occurredAt: claimed.createdAt.toISOString(),
          actorId: claimed.senderId,
          aggregateId: claimed._id.toString(),
          schemaVersion: 1,
          payload: {
            messageId: claimed._id.toString(),
            conversationId: claimed.conversationId,
            senderId: claimed.senderId,
            recipientId: claimed.recipientId,
            createdAt: claimed.createdAt.toISOString(),
          },
        };

        eventEnvelopeSchema.parse(envelope);

        const content = Buffer.from(JSON.stringify(envelope), "utf8");

        // Publish to topic exchange with persistent delivery
        await publishWithConfirm(
          this.channel,
          RABBITMQ_EXCHANGE,
          EventTypes.MESSAGE_SENT,
          content,
          {
            persistent: true,
            contentType: "application/json",
            messageId: claimed.publication.eventId,
            timestamp: claimed.createdAt.getTime(),
          }
        );

        // Mark published only after broker confirms persistent publication
        await MessageModel.updateOne(
          { _id: claimed._id },
          {
            $set: {
              "publication.publishedAt": new Date(),
              "publication.retryAfter": null,
              "publication.lastError": null,
            },
            $inc: { "publication.attempts": 1 },
          }
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const nextAttempts = (claimed.publication.attempts || 0) + 1;
        // Bounded exponential backoff: 1s, 2s, 4s, 8s ... up to 60s
        const backoffMs = Math.min(1000 * Math.pow(2, nextAttempts), 60000);
        const nextRetry = new Date(Date.now() + backoffMs);

        await MessageModel.updateOne(
          { _id: claimed._id },
          {
            $set: {
              "publication.retryAfter": nextRetry,
              "publication.lastError": errorMsg.slice(0, 500),
            },
            $inc: { "publication.attempts": 1 },
          }
        );
      }
    }

    return processedCount;
  }

  /**
   * Start the continuous dispatcher loop
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        const count = await this.processBatch();
        const delay = count > 0 ? 0 : this.pollIntervalMs;
        this.pollTimeout = setTimeout(loop, delay);
      } catch (err) {
        this.pollTimeout = setTimeout(loop, this.pollIntervalMs);
      }
    };

    loop();
  }

  /**
   * Stop the dispatcher loop
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }
}
