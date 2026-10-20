import { Channel, ConsumeMessage } from "amqplib";
import {
  RABBITMQ_QUEUES,
  EventEnvelope,
  eventEnvelopeSchema,
} from "@connectsphere/shared";

export class ModerationConsumer {
  private channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    await this.channel.prefetch(10);

    await this.channel.consume(
      RABBITMQ_QUEUES.MODERATION_EVENTS,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        try {
          const raw = msg.content.toString("utf8");
          const data = JSON.parse(raw);
          const envelope: EventEnvelope = eventEnvelopeSchema.parse(data);

          // Structured log for moderation audit trail
          process.stdout.write(
            JSON.stringify({
              level: "info",
              timestamp: new Date().toISOString(),
              service: "moderation-consumer",
              eventType: envelope.eventType,
              aggregateId: envelope.aggregateId,
              occurredAt: envelope.occurredAt,
            }) + "\n"
          );

          this.channel.ack(msg);
        } catch (err) {
          this.channel.nack(msg, false, false);
        }
      },
      { noAck: false }
    );
  }
}
