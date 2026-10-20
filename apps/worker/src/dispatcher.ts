import amqp, { ConfirmChannel } from "amqplib";
import { prisma } from "./config/prisma.js";
import {
  RABBITMQ_EXCHANGE,
  EventEnvelope,
  eventEnvelopeSchema,
} from "@connectsphere/shared";

interface RawOutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: any;
  createdAt: Date;
  attempts: number;
}

function extractActorId(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return (
    payload.authorId ||
    payload.followerId ||
    payload.userId ||
    payload.reporterId ||
    payload.moderatorId
  );
}

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

export class OutboxDispatcher {
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
   * Process a single batch of pending outbox events.
   * Uses a claim lease with row-level locking (FOR UPDATE SKIP LOCKED)
   * to support multiple concurrent dispatcher instances safely.
   */
  async processBatch(): Promise<number> {
    const claimLeaseMs = 30000; // 30s claim window
    const now = new Date();

    // 1. Atomically claim a batch of unpublished events
    const claimedEvents = await prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<RawOutboxEvent[]>`
        SELECT id, "eventType", "aggregateId", payload, "createdAt", attempts
        FROM "OutboxEvent"
        WHERE "publishedAt" IS NULL
          AND ("retryAfter" IS NULL OR "retryAfter" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (candidates.length === 0) {
        return [];
      }

      const ids = candidates.map((c) => c.id);
      const leaseExpiry = new Date(Date.now() + claimLeaseMs);

      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: {
          retryAfter: leaseExpiry,
          lastAttemptAt: new Date(),
        },
      });

      return candidates;
    });

    if (claimedEvents.length === 0) {
      return 0;
    }

    // 2. Publish each claimed event with publisher confirmation
    for (const event of claimedEvents) {
      try {
        const parsedPayload =
          typeof event.payload === "string"
            ? JSON.parse(event.payload)
            : event.payload;

        const envelope: EventEnvelope = {
          eventId: event.id,
          eventType: event.eventType,
          occurredAt: event.createdAt.toISOString(),
          actorId: extractActorId(parsedPayload),
          aggregateId: event.aggregateId,
          schemaVersion: 1,
          payload: parsedPayload,
        };

        // Validate envelope schema
        eventEnvelopeSchema.parse(envelope);

        const content = Buffer.from(JSON.stringify(envelope), "utf8");

        // Publish to topic exchange with persistent delivery
        await publishWithConfirm(
          this.channel,
          RABBITMQ_EXCHANGE,
          event.eventType,
          content,
          {
            persistent: true,
            contentType: "application/json",
            messageId: event.id,
            timestamp: event.createdAt.getTime(),
          }
        );

        // 3. Mark successfully published only after broker confirmation
        await prisma.outboxEvent.updateMany({
          where: { id: event.id },
          data: {
            publishedAt: new Date(),
            retryAfter: null,
            lastError: null,
            attempts: { increment: 1 },
          },
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const nextAttempts = event.attempts + 1;
        // Bounded exponential backoff: 1s, 2s, 4s, 8s ... up to 60s
        const backoffMs = Math.min(1000 * Math.pow(2, nextAttempts), 60000);
        const nextRetry = new Date(Date.now() + backoffMs);

        await prisma.outboxEvent.updateMany({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            retryAfter: nextRetry,
            lastError: errorMsg.slice(0, 500),
          },
        });
      }
    }

    return claimedEvents.length;
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
        // If there were events, immediately check for more; otherwise back off by poll interval
        const delay = count > 0 ? 0 : this.pollIntervalMs;
        this.pollTimeout = setTimeout(loop, delay);
      } catch (err) {
        // Prevent worker crash on transient error, log and schedule next poll
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
