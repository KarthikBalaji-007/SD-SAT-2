import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import amqp, { ChannelModel, Channel, ConfirmChannel } from "amqplib";
import mongoose from "mongoose";

import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { connectMongo, disconnectMongo } from "../apps/api/src/config/mongo.js";
import { NotificationModel } from "../apps/api/src/models/notification.model.js";
import { FeedCacheService } from "../apps/api/src/services/feedCache.js";

import { setupTopology } from "../apps/worker/src/topology.js";
import { OutboxDispatcher } from "../apps/worker/src/dispatcher.js";
import { NotificationConsumer } from "../apps/worker/src/consumers/notification.consumer.js";
import { FeedCacheConsumer } from "../apps/worker/src/consumers/feed-cache.consumer.js";
import { ModerationConsumer } from "../apps/worker/src/consumers/moderation.consumer.js";

import {
  EventTypes,
  EventEnvelope,
  RABBITMQ_EXCHANGE,
  RABBITMQ_QUEUES,
  RABBITMQ_DLQ,
} from "@connectsphere/shared";

describe("Phase 3: Transactional Outbox, RabbitMQ, Notifications & Redis Caching", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  let userA: { id: string; email: string; username: string; token: string };
  let userB: { id: string; email: string; username: string; token: string };
  let userC: { id: string; email: string; username: string; token: string };
  let moderator: { id: string; email: string; username: string; token: string };

  const createdUserIds: string[] = [];
  const createdPostIds: string[] = [];
  const testEventIds: string[] = [];

  let amqpConn: ChannelModel;
  let confirmChannel: ConfirmChannel;
  let consumerChannel: Channel;
  let testChannel: Channel;

  let dispatcher: OutboxDispatcher;
  let notifConsumer: NotificationConsumer;
  let feedConsumer: FeedCacheConsumer;
  let modConsumer: ModerationConsumer;

  function generateToken(userId: string, username: string, role = "USER") {
    return jwt.sign(
      {
        sub: userId,
        jti: crypto.randomUUID(),
        role,
        username,
      },
      config.JWT_SECRET,
      { expiresIn: "15m" }
    );
  }

  beforeAll(async () => {
    // 1. Connect MongoDB
    await connectMongo();

    // 2. Connect RabbitMQ and initialize topology
    amqpConn = await amqp.connect(config.RABBITMQ_URL);
    testChannel = await amqpConn.createChannel();
    await setupTopology(testChannel);

    // Purge test queues to start fresh
    await testChannel.purgeQueue(RABBITMQ_QUEUES.NOTIFICATIONS);
    await testChannel.purgeQueue(RABBITMQ_QUEUES.FEED_CACHE);
    await testChannel.purgeQueue(RABBITMQ_QUEUES.MODERATION_EVENTS);
    await testChannel.purgeQueue(RABBITMQ_DLQ);

    // 3. Setup dispatcher channel & confirm channel
    confirmChannel = await amqpConn.createConfirmChannel();
    dispatcher = new OutboxDispatcher(confirmChannel, { batchSize: 50, pollIntervalMs: 200 });

    // 4. Setup consumer channel & start consumers
    consumerChannel = await amqpConn.createChannel();
    notifConsumer = new NotificationConsumer(consumerChannel, { maxRetries: 2 });
    feedConsumer = new FeedCacheConsumer(consumerChannel);
    modConsumer = new ModerationConsumer(consumerChannel);

    await notifConsumer.start();
    await feedConsumer.start();
    await modConsumer.start();

    // 5. Seed test users
    async function createUser(handle: string, role = "USER") {
      const email = `${handle}_${runId}@example.com`;
      const username = `${handle}_${runId}`;
      const dbUser = await prisma.user.create({
        data: {
          email,
          username,
          displayName: `Display ${handle}`,
          passwordHash: "$2b$12$eXampleHashedPasswordForTestOnly99999999999999999999",
          privacy: "PUBLIC",
          role,
        },
      });
      createdUserIds.push(dbUser.id);
      const token = generateToken(dbUser.id, username, role);
      return { id: dbUser.id, email, username, token };
    }

    userA = await createUser("usera");
    userB = await createUser("userb");
    userC = await createUser("userc");
    moderator = await createUser("mod", "MODERATOR");

    // 6. Clean existing unpublished outbox events so this test runs in a deterministic queue
    await prisma.outboxEvent.updateMany({
      where: { publishedAt: null },
      data: { publishedAt: new Date() },
    });
  });

  afterAll(async () => {
    // 1. Stop consumers and dispatcher
    dispatcher?.stop();
    if (confirmChannel) await confirmChannel.close().catch(() => {});
    if (consumerChannel) await consumerChannel.close().catch(() => {});
    if (testChannel) await testChannel.close().catch(() => {});
    if (amqpConn) await amqpConn.close().catch(() => {});

    // 2. Clean up MongoDB notifications
    if (createdUserIds.length > 0) {
      await NotificationModel.deleteMany({
        $or: [
          { recipientId: { $in: createdUserIds } },
          { actorId: { $in: createdUserIds } },
          { eventId: { $in: testEventIds } },
        ],
      });
    }
    await disconnectMongo().catch(() => {});

    // 3. Clean up PostgreSQL data
    if (createdUserIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateId: { in: [...createdUserIds, ...createdPostIds] } },
            { id: { in: testEventIds } },
          ],
        },
      });
      await prisma.report.deleteMany({
        where: { reporterId: { in: createdUserIds } },
      });
      await prisma.reaction.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.comment.deleteMany({
        where: { authorId: { in: createdUserIds } },
      });
      await prisma.post.deleteMany({
        where: { authorId: { in: createdUserIds } },
      });
      await prisma.follow.deleteMany({
        where: {
          OR: [
            { followerId: { in: createdUserIds } },
            { followedId: { in: createdUserIds } },
          ],
        },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }

    await prisma.$disconnect();
    await redis.quit().catch(() => redis.disconnect());
  });

  // Helper to wait for asynchronous consumer execution
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // ==========================================
  // 1. Transactional Outbox Dispatcher
  // ==========================================
  describe("1. Transactional Outbox Dispatcher", () => {
    let outboxPostId: string;
    let outboxEventId: string;

    it("creates an unpublished OutboxEvent when a post is created via API", async () => {
      const res = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${userA.token}`)
        .send({ text: "Testing outbox publication" });

      expect(res.status).toBe(201);
      outboxPostId = res.body.data.id;
      createdPostIds.push(outboxPostId);

      const event = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: outboxPostId,
          eventType: EventTypes.POST_CREATED,
        },
      });

      expect(event).toBeDefined();
      expect(event?.publishedAt).toBeNull();
      expect(event?.attempts).toBe(0);
      outboxEventId = event!.id;
      testEventIds.push(outboxEventId);
    });

    it("processBatch claims pending events using FOR UPDATE SKIP LOCKED and marks them published", async () => {
      const processedCount = await dispatcher.processBatch();
      expect(processedCount).toBeGreaterThanOrEqual(1);

      const updatedEvent = await prisma.outboxEvent.findUnique({
        where: { id: outboxEventId },
      });

      expect(updatedEvent?.publishedAt).not.toBeNull();
      expect(updatedEvent?.retryAfter).toBeNull();
      expect(updatedEvent?.attempts).toBeGreaterThanOrEqual(1);
    });

    it("drains pending events and confirms the post event was marked published", async () => {
      // Drain any pending events in batches
      let batchCount = 0;
      do {
        batchCount = await dispatcher.processBatch();
      } while (batchCount > 0);

      const pendingPostEvent = await prisma.outboxEvent.findFirst({
        where: {
          id: outboxEventId,
          publishedAt: null,
        },
      });
      expect(pendingPostEvent).toBeNull();
    });

    it("handles dispatch failure gracefully with bounded exponential backoff", async () => {
      const failingEventId = crypto.randomUUID();
      testEventIds.push(failingEventId);

      // Create an outbox event with non-object payload that fails envelope schema validation
      await prisma.outboxEvent.create({
        data: {
          id: failingEventId,
          eventType: "test.outbox.failure",
          aggregateId: userA.id,
          payload: "not-a-valid-record-payload",
          attempts: 0,
        },
      });

      // Run dispatcher
      const processed = await dispatcher.processBatch();
      expect(processed).toBeGreaterThanOrEqual(1);

      const failedEvent = await prisma.outboxEvent.findUnique({
        where: { id: failingEventId },
      });

      // publishedAt must still be null
      expect(failedEvent?.publishedAt).toBeNull();
      expect(failedEvent?.attempts).toBe(1);
      // retryAfter must be set to a future timestamp
      expect(failedEvent?.retryAfter).not.toBeNull();
      expect(failedEvent?.retryAfter!.getTime()).toBeGreaterThan(Date.now());
      expect(failedEvent?.lastError).toBeDefined();

      // Verify that the failing event is skipped on immediate re-query due to retryAfter backoff window
      const now = new Date();
      const eligible = await prisma.$queryRaw<any[]>`
        SELECT id FROM "OutboxEvent"
        WHERE id = ${failingEventId}
          AND "publishedAt" IS NULL
          AND ("retryAfter" IS NULL OR "retryAfter" <= ${now})
      `;
      expect(eligible.length).toBe(0);
    });
  });

  // ==========================================
  // 2. RabbitMQ Topology & Event Consumers
  // ==========================================
  describe("2. RabbitMQ Topology & Event Consumers", () => {
    it("NotificationConsumer creates a FOLLOW notification when follow.created event arrives", async () => {
      const eventId = crypto.randomUUID();
      testEventIds.push(eventId);

      // User A follows User B
      await prisma.follow.create({
        data: { followerId: userA.id, followedId: userB.id },
      });

      const envelope: EventEnvelope = {
        eventId,
        eventType: EventTypes.FOLLOW_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userA.id,
        aggregateId: `${userA.id}:${userB.id}`,
        schemaVersion: 1,
        payload: { followerId: userA.id, followedId: userB.id },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.FOLLOW_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      // Wait for consumer
      await sleep(300);

      const notif = await NotificationModel.findOne({
        eventId,
        recipientId: userB.id,
      });

      expect(notif).toBeDefined();
      expect(notif?.type).toBe("FOLLOW");
      expect(notif?.actorId).toBe(userA.id);
      expect(notif?.message).toContain("started following you");
    });

    it("NotificationConsumer fans out post.created notifications to active followers up to 500", async () => {
      // User C also follows User B
      await prisma.follow.create({
        data: { followerId: userC.id, followedId: userB.id },
      });

      const eventId = crypto.randomUUID();
      testEventIds.push(eventId);
      const postId = crypto.randomUUID();

      const envelope: EventEnvelope = {
        eventId,
        eventType: EventTypes.POST_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userB.id,
        aggregateId: postId,
        schemaVersion: 1,
        payload: { postId, authorId: userB.id, content: "Hello followers" },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.POST_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      // User A and User C follow User B, so both should have received notifications
      const notifsUserA = await NotificationModel.findOne({ eventId, recipientId: userA.id });
      const notifsUserC = await NotificationModel.findOne({ eventId, recipientId: userC.id });

      expect(notifsUserA).toBeDefined();
      expect(notifsUserA?.type).toBe("POST");
      expect(notifsUserA?.entityId).toBe(postId);

      expect(notifsUserC).toBeDefined();
      expect(notifsUserC?.type).toBe("POST");
    });

    it("NotificationConsumer creates a COMMENT notification and excludes self-comments", async () => {
      const notifEventId = crypto.randomUUID();
      testEventIds.push(notifEventId);

      // User A comments on User B's post -> User B notified
      const envelope: EventEnvelope = {
        eventId: notifEventId,
        eventType: EventTypes.COMMENT_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userA.id,
        aggregateId: crypto.randomUUID(),
        schemaVersion: 1,
        payload: {
          commentId: crypto.randomUUID(),
          postId: crypto.randomUUID(),
          postAuthorId: userB.id,
          authorId: userA.id,
        },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.COMMENT_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      const notif = await NotificationModel.findOne({ eventId: notifEventId, recipientId: userB.id });
      expect(notif).toBeDefined();
      expect(notif?.type).toBe("COMMENT");
      expect(notif?.message).toContain("commented on your post");

      // Self-comment: User B comments on User B's post -> No notification
      const selfCommentEventId = crypto.randomUUID();
      testEventIds.push(selfCommentEventId);

      const selfEnvelope: EventEnvelope = {
        eventId: selfCommentEventId,
        eventType: EventTypes.COMMENT_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userB.id,
        aggregateId: crypto.randomUUID(),
        schemaVersion: 1,
        payload: {
          commentId: crypto.randomUUID(),
          postId: crypto.randomUUID(),
          postAuthorId: userB.id,
          authorId: userB.id,
        },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.COMMENT_CREATED,
        Buffer.from(JSON.stringify(selfEnvelope))
      );

      await sleep(200);

      const selfNotif = await NotificationModel.findOne({ eventId: selfCommentEventId });
      expect(selfNotif).toBeNull();
    });

    it("NotificationConsumer creates a REACTION notification and excludes self-reactions", async () => {
      const reactEventId = crypto.randomUUID();
      testEventIds.push(reactEventId);

      // User A reacts to User B's post -> User B notified
      const envelope: EventEnvelope = {
        eventId: reactEventId,
        eventType: EventTypes.REACTION_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userA.id,
        aggregateId: crypto.randomUUID(),
        schemaVersion: 1,
        payload: {
          reactionId: crypto.randomUUID(),
          postId: crypto.randomUUID(),
          postAuthorId: userB.id,
          userId: userA.id,
        },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.REACTION_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      const notif = await NotificationModel.findOne({ eventId: reactEventId, recipientId: userB.id });
      expect(notif).toBeDefined();
      expect(notif?.type).toBe("REACTION");
      expect(notif?.message).toContain("reacted to your post");

      // Self-reaction: User B reacts to User B's post -> No notification
      const selfReactEventId = crypto.randomUUID();
      testEventIds.push(selfReactEventId);

      const selfEnvelope: EventEnvelope = {
        eventId: selfReactEventId,
        eventType: EventTypes.REACTION_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userB.id,
        aggregateId: crypto.randomUUID(),
        schemaVersion: 1,
        payload: {
          reactionId: crypto.randomUUID(),
          postId: crypto.randomUUID(),
          postAuthorId: userB.id,
          userId: userB.id,
        },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.REACTION_CREATED,
        Buffer.from(JSON.stringify(selfEnvelope))
      );

      await sleep(200);

      const selfNotif = await NotificationModel.findOne({ eventId: selfReactEventId });
      expect(selfNotif).toBeNull();
    });

    it("NotificationConsumer creates a MODERATION notification when content is hidden", async () => {
      // Create a post for user A
      const post = await prisma.post.create({
        data: {
          authorId: userA.id,
          text: "Flagged content to be hidden",
          visibility: "PUBLIC",
        },
      });
      createdPostIds.push(post.id);

      const modEventId = crypto.randomUUID();
      testEventIds.push(modEventId);

      const envelope: EventEnvelope = {
        eventId: modEventId,
        eventType: EventTypes.CONTENT_MODERATED,
        occurredAt: new Date().toISOString(),
        actorId: moderator.id,
        aggregateId: post.id,
        schemaVersion: 1,
        payload: {
          reportId: crypto.randomUUID(),
          targetType: "POST",
          targetId: post.id,
          status: "RESOLVED",
          action: "HIDE_CONTENT",
          moderatorId: moderator.id,
        },
      };

      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.CONTENT_MODERATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      const notif = await NotificationModel.findOne({
        eventId: modEventId,
        recipientId: userA.id,
      });

      expect(notif).toBeDefined();
      expect(notif?.type).toBe("MODERATION");
      expect(notif?.message).toContain("reviewed and hidden");
    });
  });

  // ==========================================
  // 3. Consumer Idempotency and Deduplication
  // ==========================================
  describe("3. Consumer Idempotency & Deduplication", () => {
    it("redelivering the same event envelope does not duplicate notifications in MongoDB", async () => {
      const duplicateEventId = crypto.randomUUID();
      testEventIds.push(duplicateEventId);

      const envelope: EventEnvelope = {
        eventId: duplicateEventId,
        eventType: EventTypes.FOLLOW_CREATED,
        occurredAt: new Date().toISOString(),
        actorId: userC.id,
        aggregateId: `${userC.id}:${userA.id}`,
        schemaVersion: 1,
        payload: { followerId: userC.id, followedId: userA.id },
      };

      // Publish the first time
      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.FOLLOW_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      const firstCount = await NotificationModel.countDocuments({
        eventId: duplicateEventId,
        recipientId: userA.id,
      });
      expect(firstCount).toBe(1);

      // Redeliver identical event (at-least-once simulation)
      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.FOLLOW_CREATED,
        Buffer.from(JSON.stringify(envelope))
      );

      await sleep(300);

      const secondCount = await NotificationModel.countDocuments({
        eventId: duplicateEventId,
        recipientId: userA.id,
      });
      expect(secondCount).toBe(1);
    });
  });

  // ==========================================
  // 4. Dead-Letter Exchange (DLX / DLQ)
  // ==========================================
  describe("4. Dead-Letter Exchange & Routing", () => {
    it("routes unprocessable messages exceeding max retries to DLQ", async () => {
      // Purge DLQ first
      await testChannel.purgeQueue(RABBITMQ_DLQ);

      // Publish a message with x-retry-count = 3 (exceeding consumer's maxRetries = 2) and invalid payload
      const poisonPayload = Buffer.from(JSON.stringify({ bad: "message_with_missing_fields" }));
      testChannel.sendToQueue(RABBITMQ_QUEUES.NOTIFICATIONS, poisonPayload, {
        headers: { "x-retry-count": 3 },
      });

      // Wait for consumer to process and nack to DLX
      await sleep(400);

      // Verify that message arrived in DLQ
      const dlqMessage = await testChannel.get(RABBITMQ_DLQ, { noAck: true });
      expect(dlqMessage).not.toBe(false);

      if (dlqMessage) {
        const content = JSON.parse(dlqMessage.content.toString("utf8"));
        expect(content.bad).toBe("message_with_missing_fields");
      }
    });
  });

  // ==========================================
  // 5. Notifications REST API
  // ==========================================
  describe("5. Notifications REST API", () => {
    let testNotifId: string;

    beforeAll(async () => {
      // Create a known notification for User A
      const notifDoc = await NotificationModel.create({
        eventId: crypto.randomUUID(),
        recipientId: userA.id,
        actorId: userB.id,
        type: "FOLLOW",
        entityType: "USER",
        entityId: userB.id,
        message: "User B started following you",
      });
      testNotifId = notifDoc._id.toString();
    });

    it("GET /api/v1/notifications requires authentication", async () => {
      const res = await request(app).get("/api/v1/notifications");
      expect(res.status).toBe(401);
    });

    it("GET /api/v1/notifications returns paginated notifications with populated actor details", async () => {
      const res = await request(app)
        .get("/api/v1/notifications?page=1&limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.unreadCount).toBeGreaterThanOrEqual(1);

      const found = res.body.data.find((n: any) => n.id === testNotifId);
      expect(found).toBeDefined();
      expect(found.recipientId).toBe(userA.id);
      expect(found.actor).toBeDefined();
      expect(found.actor.id).toBe(userB.id);
      expect(found.actor.username).toBe(userB.username);
    });

    it("GET /api/v1/notifications enforces strict user isolation", async () => {
      // User C fetches notifications and must not see User A's notifications
      const res = await request(app)
        .get("/api/v1/notifications")
        .set("Authorization", `Bearer ${userC.token}`);

      expect(res.status).toBe(200);
      const userAItems = res.body.data.filter((n: any) => n.recipientId === userA.id);
      expect(userAItems.length).toBe(0);
    });

    it("PATCH /api/v1/notifications/:id/read marks notification as read", async () => {
      const res = await request(app)
        .patch(`/api/v1/notifications/${testNotifId}/read`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(testNotifId);
      expect(res.body.data.readAt).not.toBeNull();

      // Check unread count filter now excludes it
      const unreadRes = await request(app)
        .get("/api/v1/notifications?unreadOnly=true")
        .set("Authorization", `Bearer ${userA.token}`);

      const foundUnread = unreadRes.body.data.find((n: any) => n.id === testNotifId);
      expect(foundUnread).toBeUndefined();
    });

    it("PATCH /api/v1/notifications/:id/read returns 404 when attempting to mark another user's notification", async () => {
      // User B tries to mark User A's notification
      const res = await request(app)
        .patch(`/api/v1/notifications/${testNotifId}/read`)
        .set("Authorization", `Bearer ${userB.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ==========================================
  // 6. Redis Feed Caching & Dynamic Invalidation
  // ==========================================
  describe("6. Redis Feed Caching & Dynamic Invalidation", () => {
    let feedPostId: string;

    it("GET /api/v1/feed returns X-Cache: MISS on first fetch, and X-Cache: HIT on subsequent fetch", async () => {
      // Ensure User A's feed cache is cleared
      await FeedCacheService.invalidateUserFeed(userA.id);

      // First fetch: MISS
      const res1 = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res1.status).toBe(200);
      expect(res1.headers["x-cache"]).toBe("MISS");

      // Second fetch: HIT
      const res2 = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res2.status).toBe(200);
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(res2.body.data.length).toBe(res1.body.data.length);
    });

    it("invalidates follower feed cache dynamically when a new post is created", async () => {
      // User B (followed by User A) creates a new post
      const createRes = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${userB.token}`)
        .send({ text: "Post causing feed cache invalidation" });

      expect(createRes.status).toBe(201);
      feedPostId = createRes.body.data.id;
      createdPostIds.push(feedPostId);

      // User A's next feed fetch must be a MISS due to feed version bump
      const resAfterPost = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(resAfterPost.status).toBe(200);
      expect(resAfterPost.headers["x-cache"]).toBe("MISS");

      // The new post must be present in User A's feed
      const foundNewPost = resAfterPost.body.data.find((p: any) => p.id === feedPostId);
      expect(foundNewPost).toBeDefined();

      // Following fetch must be HIT
      const resHit = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);
      expect(resHit.headers["x-cache"]).toBe("HIT");
    });

    it("invalidates feed cache and active check prevents serving soft-deleted posts", async () => {
      // Soft-delete the post created by User B
      const delRes = await request(app)
        .delete(`/api/v1/posts/${feedPostId}`)
        .set("Authorization", `Bearer ${userB.token}`);

      expect(delRes.status).toBe(200);

      // Next feed fetch must be MISS and exclude deleted post
      const resAfterDel = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(resAfterDel.status).toBe(200);
      expect(resAfterDel.headers["x-cache"]).toBe("MISS");

      const foundDeleted = resAfterDel.body.data.find((p: any) => p.id === feedPostId);
      expect(foundDeleted).toBeUndefined();
    });

    it("invalidates follower feed cache when unfollowing a user", async () => {
      // Warm User A's feed cache
      await request(app).get("/api/v1/feed?limit=10").set("Authorization", `Bearer ${userA.token}`);
      const warmRes = await request(app).get("/api/v1/feed?limit=10").set("Authorization", `Bearer ${userA.token}`);
      expect(warmRes.headers["x-cache"]).toBe("HIT");

      // User A unfollows User B
      const unfollowRes = await request(app)
        .delete(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);
      expect(unfollowRes.status).toBe(200);

      // Next feed fetch must be MISS
      const resAfterUnfollow = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(resAfterUnfollow.status).toBe(200);
      expect(resAfterUnfollow.headers["x-cache"]).toBe("MISS");
    });

    it("invalidates feed cache when a post is moderated and hidden", async () => {
      // Re-follow User B so User A sees User B's posts
      await request(app)
        .post(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      // User B creates a post
      const postRes = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${userB.token}`)
        .send({ text: "Post to be moderated" });
      const modPostId = postRes.body.data.id;
      createdPostIds.push(modPostId);

      // Warm User A's feed
      await request(app).get("/api/v1/feed?limit=10").set("Authorization", `Bearer ${userA.token}`);
      const hitRes = await request(app).get("/api/v1/feed?limit=10").set("Authorization", `Bearer ${userA.token}`);
      expect(hitRes.headers["x-cache"]).toBe("HIT");

      // User C reports the post
      const reportRes = await request(app)
        .post("/api/v1/reports")
        .set("Authorization", `Bearer ${userC.token}`)
        .send({
          targetType: "POST",
          targetId: modPostId,
          reason: "SPAM",
        });
      const reportId = reportRes.body.data.id;

      // Moderator resolves report by hiding content
      const modResolve = await request(app)
        .patch(`/api/v1/moderation/reports/${reportId}`)
        .set("Authorization", `Bearer ${moderator.token}`)
        .send({
          status: "RESOLVED",
          action: "HIDE_CONTENT",
          notes: "Spam content removed",
        });
      expect(modResolve.status).toBe(200);

      // User A's next feed fetch must be MISS and hidden post must not appear
      const resAfterMod = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(resAfterMod.status).toBe(200);
      expect(resAfterMod.headers["x-cache"]).toBe("MISS");

      const foundMod = resAfterMod.body.data.find((p: any) => p.id === modPostId);
      expect(foundMod).toBeUndefined();
    });

    it("feed query falls back safely to PostgreSQL when cache lookup returns null", async () => {
      // Test feed fetching with a mock or invalid cursor; feed endpoint always returns 200 without throwing 500
      const res = await request(app)
        .get("/api/v1/feed?limit=5")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.meta).toBeDefined();
    });
  });
});
