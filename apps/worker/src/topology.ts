import { Channel } from "amqplib";
import {
  RABBITMQ_EXCHANGE,
  RABBITMQ_DLX,
  RABBITMQ_DLQ,
  RABBITMQ_QUEUES,
  EventTypes,
} from "@connectsphere/shared";

export async function setupTopology(channel: Channel): Promise<void> {
  // 1. Declare dead-letter exchange and queue
  await channel.assertExchange(RABBITMQ_DLX, "topic", { durable: true });
  await channel.assertQueue(RABBITMQ_DLQ, { durable: true });
  await channel.bindQueue(RABBITMQ_DLQ, RABBITMQ_DLX, "#");

  // 2. Declare primary topic exchange
  await channel.assertExchange(RABBITMQ_EXCHANGE, "topic", { durable: true });

  // 3. Declare notifications queue and bindings
  const deadLetterArgs = (routingKey: string) => ({
    "x-dead-letter-exchange": RABBITMQ_DLX,
    "x-dead-letter-routing-key": routingKey,
  });

  await channel.assertQueue(RABBITMQ_QUEUES.NOTIFICATIONS, {
    durable: true,
    arguments: deadLetterArgs("notifications.dlq"),
  });
  const notificationBindings = [
    EventTypes.FOLLOW_CREATED,
    EventTypes.POST_CREATED,
    EventTypes.COMMENT_CREATED,
    EventTypes.REACTION_CREATED,
    EventTypes.CONTENT_REPORTED,
    EventTypes.CONTENT_MODERATED,
    EventTypes.MESSAGE_SENT,
  ];
  for (const rk of notificationBindings) {
    await channel.bindQueue(RABBITMQ_QUEUES.NOTIFICATIONS, RABBITMQ_EXCHANGE, rk);
  }

  // 4. Declare feed-cache queue and bindings
  await channel.assertQueue(RABBITMQ_QUEUES.FEED_CACHE, {
    durable: true,
    arguments: deadLetterArgs("feed-cache.dlq"),
  });
  const feedCacheBindings = [
    EventTypes.POST_CREATED,
    EventTypes.POST_UPDATED,
    EventTypes.POST_DELETED,
    EventTypes.FOLLOW_CREATED,
    EventTypes.FOLLOW_DELETED,
    EventTypes.CONTENT_MODERATED,
  ];
  for (const rk of feedCacheBindings) {
    await channel.bindQueue(RABBITMQ_QUEUES.FEED_CACHE, RABBITMQ_EXCHANGE, rk);
  }

  // 5. Declare moderation-events queue and bindings
  await channel.assertQueue(RABBITMQ_QUEUES.MODERATION_EVENTS, {
    durable: true,
    arguments: deadLetterArgs("moderation.dlq"),
  });
  const moderationBindings = [
    EventTypes.CONTENT_REPORTED,
    EventTypes.CONTENT_MODERATED,
  ];
  for (const rk of moderationBindings) {
    await channel.bindQueue(RABBITMQ_QUEUES.MODERATION_EVENTS, RABBITMQ_EXCHANGE, rk);
  }
}
