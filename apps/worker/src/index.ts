import amqp, { ChannelModel, Channel, ConfirmChannel } from "amqplib";
import { config } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./config/mongo.js";
import { redis } from "./config/redis.js";
import { prisma } from "./config/prisma.js";
import { setupTopology } from "./topology.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { MessageDispatcher } from "./messageDispatcher.js";
import { NotificationConsumer } from "./consumers/notification.consumer.js";
import { FeedCacheConsumer } from "./consumers/feed-cache.consumer.js";
import { ModerationConsumer } from "./consumers/moderation.consumer.js";

let connection: ChannelModel | null = null;
let consumerChannel: Channel | null = null;
let dispatcherChannel: ConfirmChannel | null = null;
let dispatcher: OutboxDispatcher | null = null;
let messageDispatcher: MessageDispatcher | null = null;
let isShuttingDown = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  process.stdout.write(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      service: "worker",
      message,
      ...meta,
    }) + "\n"
  );
}

export async function startWorkerServices(): Promise<{
  connection: ChannelModel;
  dispatcher: OutboxDispatcher;
  messageDispatcher: MessageDispatcher;
}> {
  log("info", "Starting ConnectSphere Background Worker services");

  // 1. Connect to MongoDB
  await connectMongo();
  log("info", "Connected to MongoDB for notification storage");

  // 2. Connect to RabbitMQ
  connection = await amqp.connect(config.RABBITMQ_URL);

  connection.on("error", (err) => {
    log("error", "RabbitMQ connection error occurred", { error: err.message });
    if (!isShuttingDown) scheduleReconnect(1);
  });

  connection.on("close", () => {
    log("warn", "RabbitMQ connection closed");
    if (!isShuttingDown) scheduleReconnect(1);
  });

  // 3. Topology setup
  const setupChannel = await connection.createChannel();
  await setupTopology(setupChannel);
  await setupChannel.close();
  log("info", "RabbitMQ topology declared (social.events, queues, dead-letter DLX/DLQ)");

  // 4. Create consumer channel and start consumers
  consumerChannel = await connection.createChannel();
  const notificationConsumer = new NotificationConsumer(consumerChannel);
  const feedCacheConsumer = new FeedCacheConsumer(consumerChannel);
  const moderationConsumer = new ModerationConsumer(consumerChannel);

  await notificationConsumer.start();
  await feedCacheConsumer.start();
  await moderationConsumer.start();
  log("info", "Event consumers started (notifications, feed-cache, moderation-events)");

  // 5. Create confirm channel and start Outbox & Message Dispatchers
  dispatcherChannel = await connection.createConfirmChannel();
  dispatcher = new OutboxDispatcher(dispatcherChannel, {
    batchSize: config.OUTBOX_BATCH_SIZE,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  });
  dispatcher.start();
  log("info", "PostgreSQL Outbox Dispatcher started with publisher confirmations");

  messageDispatcher = new MessageDispatcher(dispatcherChannel, {
    batchSize: config.OUTBOX_BATCH_SIZE,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  });
  messageDispatcher.start();
  log("info", "MongoDB Message Dispatcher started with publisher confirmations");

  return { connection, dispatcher, messageDispatcher };
}

export async function connectWithRetry(
  attempt = 1,
  delayMs = config.INITIAL_RECONNECT_DELAY_MS
): Promise<ChannelModel | null> {
  if (isShuttingDown) return null;

  try {
    log("info", `Attempting connection to RabbitMQ (attempt ${attempt}/${config.MAX_RECONNECT_ATTEMPTS})`);
    const services = await startWorkerServices();
    return services.connection;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("warn", `Worker initialization failed: ${errorMsg}`);

    if (attempt < config.MAX_RECONNECT_ATTEMPTS) {
      const nextDelay = Math.min(delayMs * 2, config.MAX_RECONNECT_DELAY_MS);
      log("info", `Scheduling reconnect attempt ${attempt + 1} in ${delayMs}ms`);
      return new Promise((resolve) => {
        reconnectTimer = setTimeout(async () => {
          resolve(await connectWithRetry(attempt + 1, nextDelay));
        }, delayMs);
      });
    } else {
      log("error", `Exceeded max reconnect attempts (${config.MAX_RECONNECT_ATTEMPTS})`);
      return null;
    }
  }
}

function scheduleReconnect(attempt: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWithRetry(attempt);
  }, config.INITIAL_RECONNECT_DELAY_MS);
}

export async function shutdownWorker(signal: string) {
  isShuttingDown = true;
  log("info", `Worker received ${signal}, initiating graceful shutdown`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (dispatcher) {
      dispatcher.stop();
      log("info", "Outbox Dispatcher stopped");
    }
    if (messageDispatcher) {
      messageDispatcher.stop();
      log("info", "Message Dispatcher stopped");
    }
    if (consumerChannel) {
      await consumerChannel.close().catch(() => {});
      log("info", "Consumer channel closed");
    }
    if (dispatcherChannel) {
      await dispatcherChannel.close().catch(() => {});
      log("info", "Dispatcher confirm channel closed");
    }
    if (connection) {
      await connection.close().catch(() => {});
      log("info", "RabbitMQ connection closed");
    }
    await disconnectMongo().catch(() => {});
    await redis.quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    log("info", "Databases disconnected cleanly");
  } catch (err) {
    log("error", "Error while closing worker connections", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log("info", "Worker shutdown complete");
  if (process.env.NODE_ENV !== "test") {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdownWorker("SIGINT"));
process.on("SIGTERM", () => shutdownWorker("SIGTERM"));

if (process.env.NODE_ENV !== "test") {
  log("info", "Starting ConnectSphere Background Worker", { env: config.NODE_ENV });
  connectWithRetry();
}
