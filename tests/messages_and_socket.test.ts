import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import http from "http";
import { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import amqp, { ChannelModel, Channel, ConfirmChannel } from "amqplib";

import { app, httpServer } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { connectMongo, disconnectMongo } from "../apps/api/src/config/mongo.js";
import { ConversationModel } from "../apps/api/src/models/conversation.model.js";
import { MessageModel } from "../apps/api/src/models/message.model.js";
import { NotificationModel } from "../apps/api/src/models/notification.model.js";

import { setupTopology } from "../apps/worker/src/topology.js";
import { MessageDispatcher } from "../apps/worker/src/messageDispatcher.js";
import { NotificationConsumer } from "../apps/worker/src/consumers/notification.consumer.js";

import {
  EventTypes,
  EventEnvelope,
  RABBITMQ_EXCHANGE,
  RABBITMQ_QUEUES,
} from "@connectsphere/shared";

describe("Phase 4: Direct Messaging & Real-Time Socket.IO Integration", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  let alice: { id: string; email: string; username: string; token: string };
  let bob: { id: string; email: string; username: string; token: string };
  let charlie: { id: string; email: string; username: string; token: string }; // Third-party / unauthorized

  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  let sharedConvId: string;

  let serverPort: number;
  let serverInstance: http.Server;

  let amqpConn: ChannelModel;
  let confirmChannel: ConfirmChannel;
  let consumerChannel: Channel;
  let testChannel: Channel;

  let messageDispatcher: MessageDispatcher;
  let notifConsumer: NotificationConsumer;

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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    // 1. Connect MongoDB & ensure index sync
    await connectMongo();
    try {
      await MessageModel.collection.dropIndex("senderId_1_idempotencyKey_1");
    } catch {}
    await MessageModel.syncIndexes();

    // 2. Start HTTP server on dynamic port for Socket.IO tests
    await new Promise<void>((resolve) => {
      serverInstance = httpServer.listen(0, () => {
        serverPort = (serverInstance.address() as AddressInfo).port;
        resolve();
      });
    });

    // 3. Connect RabbitMQ and initialize topology
    amqpConn = await amqp.connect(config.RABBITMQ_URL);
    testChannel = await amqpConn.createChannel();
    await setupTopology(testChannel);

    confirmChannel = await amqpConn.createConfirmChannel();
    messageDispatcher = new MessageDispatcher(confirmChannel, { batchSize: 50, pollIntervalMs: 200 });

    consumerChannel = await amqpConn.createChannel();
    notifConsumer = new NotificationConsumer(consumerChannel);
    await notifConsumer.start();

    // 4. Seed test users
    async function createUser(handle: string) {
      const email = `${handle}_${runId}@example.com`;
      const username = `${handle}_${runId}`;
      const dbUser = await prisma.user.create({
        data: {
          email,
          username,
          displayName: `Display ${handle}`,
          passwordHash: "$2b$12$eXampleHashedPasswordForTestOnly99999999999999999999",
          privacy: "PUBLIC",
          role: "USER",
        },
      });
      createdUserIds.push(dbUser.id);
      const token = generateToken(dbUser.id, username);
      return { id: dbUser.id, email, username, token };
    }

    alice = await createUser("alice");
    bob = await createUser("bob");
    charlie = await createUser("charlie");
  });

  afterAll(async () => {
    // 1. Stop message dispatcher and AMQP channels
    messageDispatcher?.stop();
    await sleep(200);
    if (confirmChannel) await confirmChannel.close().catch(() => {});
    if (consumerChannel) await consumerChannel.close().catch(() => {});
    if (testChannel) await testChannel.close().catch(() => {});
    if (amqpConn) await amqpConn.close().catch(() => {});

    // 2. Close HTTP server
    if (serverInstance) {
      await new Promise<void>((resolve) => serverInstance.close(() => resolve()));
    }

    // 3. Clean up MongoDB data
    if (createdConversationIds.length > 0) {
      await MessageModel.deleteMany({ conversationId: { $in: createdConversationIds } });
      await ConversationModel.deleteMany({ _id: { $in: createdConversationIds } });
    }
    if (createdUserIds.length > 0) {
      await MessageModel.deleteMany({
        $or: [{ senderId: { $in: createdUserIds } }, { recipientId: { $in: createdUserIds } }],
      });
      await ConversationModel.deleteMany({ participantIds: { $in: createdUserIds } });
      await NotificationModel.deleteMany({
        $or: [{ recipientId: { $in: createdUserIds } }, { actorId: { $in: createdUserIds } }],
      });
    }
    await disconnectMongo().catch(() => {});

    // 4. Clean up PostgreSQL data
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }

    await prisma.$disconnect();
    await redis.quit().catch(() => redis.disconnect());
  });

  // Helper to create a connected client socket with authentication
  function createSocketClient(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(`http://localhost:${serverPort}`, {
        auth: { token },
        transports: ["websocket"],
        reconnection: false,
        timeout: 5000,
      });

      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (err) => reject(err));
    });
  }

  // ==========================================
  // 1. Conversation Lifecycle & Access Control
  // ==========================================
  describe("1. Conversation Lifecycle & Access Control", () => {
    it("POST /api/v1/conversations creates a conversation between two distinct users", async () => {
      const res = await request(app)
        .post("/api/v1/conversations")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ recipientId: bob.id });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.participantIds).toContain(alice.id);
      expect(res.body.data.participantIds).toContain(bob.id);
      expect(res.body.data.participants).toHaveLength(2);

      sharedConvId = res.body.data.id;
      createdConversationIds.push(sharedConvId);
    });

    it("POST /api/v1/conversations is idempotent and returns existing conversation for the same pair", async () => {
      // Bob requests conversation with Alice
      const res = await request(app)
        .post("/api/v1/conversations")
        .set("Authorization", `Bearer ${bob.token}`)
        .send({ recipientId: alice.id });

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(sharedConvId);
    });

    it("POST /api/v1/conversations rejects self-conversation with HTTP 400", async () => {
      const res = await request(app)
        .post("/api/v1/conversations")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ recipientId: alice.id });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_REQUEST");
    });

    it("POST /api/v1/conversations rejects non-existent recipient with HTTP 404", async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await request(app)
        .post("/api/v1/conversations")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ recipientId: nonExistentId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("USER_NOT_FOUND");
    });

    it("GET /api/v1/conversations returns only conversations the authenticated user belongs to", async () => {
      // Alice queries conversations: should see the conversation with Bob
      const resAlice = await request(app)
        .get("/api/v1/conversations")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(resAlice.status).toBe(200);
      expect(resAlice.body.data).toHaveLength(1);
      expect(resAlice.body.data[0].id).toBe(sharedConvId);

      // Charlie queries conversations: must see 0 conversations (strict isolation)
      const resCharlie = await request(app)
        .get("/api/v1/conversations")
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(resCharlie.status).toBe(200);
      expect(resCharlie.body.data).toHaveLength(0);
    });
  });

  // ==========================================
  // 2. Direct Messages & Idempotency
  // ==========================================
  describe("2. Direct Messages & Idempotency", () => {
    let testConvId: string;
    let messageId: string;

    beforeAll(() => {
      testConvId = sharedConvId;
    });

    it("POST /api/v1/conversations/:id/messages successfully sends and persists a message", async () => {
      const res = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Hello Bob! How are you?" });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.text).toBe("Hello Bob! How are you?");
      expect(res.body.data.senderId).toBe(alice.id);
      expect(res.body.data.recipientId).toBe(bob.id);
      expect(res.body.data.readAt).toBeNull();

      messageId = res.body.data.id;

      // Verify message exists in MongoDB with pending publication state
      const dbMsg = await MessageModel.findById(messageId);
      expect(dbMsg).not.toBeNull();
      expect(dbMsg?.publication.publishedAt).toBeNull();
      expect(dbMsg?.publication.eventId).toBeDefined();

      // Verify conversation activity metadata updated
      const updatedConv = await ConversationModel.findById(testConvId);
      expect(updatedConv?.lastMessageText).toBe("Hello Bob! How are you?");
      expect(updatedConv?.lastMessageSenderId).toBe(alice.id);
      expect(updatedConv?.lastMessageAt).not.toBeNull();
    });

    it("POST /api/v1/conversations/:id/messages rejects empty or oversized content", async () => {
      // Empty text
      const emptyRes = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "   " });
      expect(emptyRes.status).toBe(400);

      // Oversized text (>5000 chars)
      const oversizedRes = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "A".repeat(5001) });
      expect(oversizedRes.status).toBe(400);
    });

    it("POST /api/v1/conversations/:id/messages is idempotent when client supplies idempotencyKey", async () => {
      const idempotencyKey = `client-retry-${crypto.randomUUID()}`;

      // First send
      const res1 = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Retryable message", idempotencyKey });

      expect(res1.status).toBe(201);
      const firstMessageId = res1.body.data.id;

      // Exact same retry with identical idempotencyKey
      const res2 = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Retryable message", idempotencyKey });

      expect(res2.status).toBe(201);
      expect(res2.body.data.id).toBe(firstMessageId);

      // Database should only have 1 document for this idempotency key
      const count = await MessageModel.countDocuments({
        senderId: alice.id,
        idempotencyKey,
      });
      expect(count).toBe(1);
    });

    it("POST /api/v1/conversations/:id/messages blocks non-participants with HTTP 404", async () => {
      // Charlie tries to send a message into Alice & Bob's conversation
      const res = await request(app)
        .post(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${charlie.token}`)
        .send({ text: "I am an eavesdropper" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /api/v1/conversations/:id/messages returns paginated history for participants", async () => {
      const res = await request(app)
        .get(`/api/v1/conversations/${testConvId}/messages?limit=10`)
        .set("Authorization", `Bearer ${bob.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.meta).toBeDefined();
    });

    it("GET /api/v1/conversations/:id/messages blocks non-participants with HTTP 404", async () => {
      const res = await request(app)
        .get(`/api/v1/conversations/${testConvId}/messages`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(res.status).toBe(404);
    });

    it("PATCH /api/v1/messages/:id/read marks message as read by the recipient", async () => {
      // Bob (the recipient) marks Alice's message as read
      const res = await request(app)
        .patch(`/api/v1/messages/${messageId}/read`)
        .set("Authorization", `Bearer ${bob.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(messageId);
      expect(res.body.data.readAt).not.toBeNull();

      // Repeated call is idempotent
      const repeatRes = await request(app)
        .patch(`/api/v1/messages/${messageId}/read`)
        .set("Authorization", `Bearer ${bob.token}`);

      expect(repeatRes.status).toBe(200);
      expect(repeatRes.body.data.readAt).toBe(res.body.data.readAt);
    });

    it("PATCH /api/v1/messages/:id/read blocks non-recipients with HTTP 404", async () => {
      // Alice (the sender) tries to mark her own sent message as read
      const resAlice = await request(app)
        .patch(`/api/v1/messages/${messageId}/read`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(resAlice.status).toBe(404);

      // Charlie (unrelated) tries to mark the message as read
      const resCharlie = await request(app)
        .patch(`/api/v1/messages/${messageId}/read`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(resCharlie.status).toBe(404);
    });
  });

  // ==========================================
  // 3. Durable Outbox & RabbitMQ Notification
  // ==========================================
  describe("3. Durable Outbox & RabbitMQ Notification", () => {
    let outboxConvId: string;
    let outboxMsgId: string;
    let eventId: string;

    beforeAll(async () => {
      outboxConvId = sharedConvId;

      const msg = await MessageModel.create({
        conversationId: outboxConvId,
        senderId: alice.id,
        recipientId: bob.id,
        text: "Durable notification test message",
        publication: {
          eventId: crypto.randomUUID(),
          publishedAt: null,
          attempts: 0,
          lastAttemptAt: null,
          retryAfter: null,
          lastError: null,
        },
      });
      outboxMsgId = msg._id.toString();
      eventId = msg.publication.eventId;
    });

    it("MessageDispatcher claims unpublished messages and marks them published after broker confirmation", async () => {
      const count = await messageDispatcher.processBatch();
      expect(count).toBeGreaterThanOrEqual(1);

      const updated = await MessageModel.findById(outboxMsgId);
      expect(updated?.publication.publishedAt).not.toBeNull();
      expect(updated?.publication.retryAfter).toBeNull();
      expect(updated?.publication.attempts).toBe(1);
    });

    it("NotificationConsumer receives message.sent and creates a recipient notification in MongoDB", async () => {
      // Give consumer time to process message from RabbitMQ queue
      await sleep(350);

      const notif = await NotificationModel.findOne({
        eventId,
        recipientId: bob.id,
      });

      expect(notif).not.toBeNull();
      expect(notif?.type).toBe("MESSAGE");
      expect(notif?.entityType).toBe("CONVERSATION");
      expect(notif?.entityId).toBe(outboxConvId);
      expect(notif?.message).toContain("sent you a message");
    });

    it("deduplicates redelivered message.sent events using unique compound index", async () => {
      const duplicateEnvelope: EventEnvelope = {
        eventId,
        eventType: EventTypes.MESSAGE_SENT,
        occurredAt: new Date().toISOString(),
        actorId: alice.id,
        aggregateId: outboxMsgId,
        schemaVersion: 1,
        payload: {
          messageId: outboxMsgId,
          conversationId: outboxConvId,
          senderId: alice.id,
          recipientId: bob.id,
          createdAt: new Date().toISOString(),
        },
      };

      // Redeliver identical message event
      testChannel.publish(
        RABBITMQ_EXCHANGE,
        EventTypes.MESSAGE_SENT,
        Buffer.from(JSON.stringify(duplicateEnvelope))
      );

      await sleep(300);

      const count = await NotificationModel.countDocuments({
        eventId,
        recipientId: bob.id,
      });

      // Total count must remain strictly 1
      expect(count).toBe(1);
    });
  });

  // ==========================================
  // 4. Socket.IO Authentication & Real-Time Delivery
  // ==========================================
  describe("4. Socket.IO Authentication & Real-Time Delivery", () => {
    let socketAlice: ClientSocket;
    let socketBob: ClientSocket;
    let socketCharlie: ClientSocket;
    let socketConvId: string;

    beforeAll(() => {
      socketConvId = sharedConvId;
    });

    afterAll(() => {
      socketAlice?.disconnect();
      socketBob?.disconnect();
      socketCharlie?.disconnect();
    });

    it("authenticates valid socket connection via JWT handshake", async () => {
      socketAlice = await createSocketClient(alice.token);
      socketBob = await createSocketClient(bob.token);
      socketCharlie = await createSocketClient(charlie.token);

      expect(socketAlice.connected).toBe(true);
      expect(socketBob.connected).toBe(true);
      expect(socketCharlie.connected).toBe(true);
    });

    it("rejects socket connection with invalid or expired token", async () => {
      await expect(createSocketClient("invalid-token-string")).rejects.toThrow();

      const expiredToken = jwt.sign(
        { sub: alice.id, jti: crypto.randomUUID() },
        config.JWT_SECRET,
        { expiresIn: "-1s" }
      );
      await expect(createSocketClient(expiredToken)).rejects.toThrow();
    });

    it("rejects socket connection when token is revoked in Redis", async () => {
      const revokedJti = crypto.randomUUID();
      const revokedToken = jwt.sign(
        { sub: alice.id, jti: revokedJti, username: alice.username, role: "USER" },
        config.JWT_SECRET,
        { expiresIn: "15m" }
      );

      // Mark token as revoked in Redis
      await redis.set(`revoked_token:${revokedJti}`, "true", "EX", 900);

      await expect(createSocketClient(revokedToken)).rejects.toThrow();
    });

    it("allows participants to join conversation room and rejects non-participants", async () => {
      // Alice (participant) joins
      const aliceJoinPromise = new Promise<any>((resolve) => {
        socketAlice.emit("join:conversation", socketConvId, (res: any) => resolve(res));
      });
      const aliceRes = await aliceJoinPromise;
      expect(aliceRes.joined).toBe(true);

      // Charlie (non-participant) tries to join
      const charlieJoinPromise = new Promise<any>((resolve) => {
        socketCharlie.emit("join:conversation", socketConvId, (res: any) => resolve(res));
      });
      const charlieRes = await charlieJoinPromise;
      expect(charlieRes.error).toBeDefined();
      expect(charlieRes.error.code).toBe("UNAUTHORIZED");
    });

    it("delivers real-time message:new event to connected recipient when message is sent via REST", async () => {
      // Setup listener on Bob's socket
      const receivedMessagePromise = new Promise<any>((resolve) => {
        socketBob.once("message:new", (data) => resolve(data));
      });

      // Alice sends message through the REST API
      const res = await request(app)
        .post(`/api/v1/conversations/${socketConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Hey Bob! Live socket test message!" });

      expect(res.status).toBe(201);
      const sentMessageId = res.body.data.id;

      // Bob receives it live over Socket.IO
      const received = await receivedMessagePromise;
      expect(received).toBeDefined();
      expect(received.message.id).toBe(sentMessageId);
      expect(received.message.text).toBe("Hey Bob! Live socket test message!");
      expect(received.message.senderId).toBe(alice.id);
    });

    it("delivers real-time message:read event to sender when recipient marks message read", async () => {
      // Send message from Alice to Bob
      const msgRes = await request(app)
        .post(`/api/v1/conversations/${socketConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Message to be read in real-time" });
      const testMsgId = msgRes.body.data.id;

      // Alice listens for message:read receipt
      const readReceiptPromise = new Promise<any>((resolve) => {
        socketAlice.once("message:read", (data) => resolve(data));
      });

      // Bob marks as read via REST
      const readRes = await request(app)
        .patch(`/api/v1/messages/${testMsgId}/read`)
        .set("Authorization", `Bearer ${bob.token}`);
      expect(readRes.status).toBe(200);

      // Alice receives real-time receipt
      const receipt = await readReceiptPromise;
      expect(receipt.messageId).toBe(testMsgId);
      expect(receipt.conversationId).toBe(socketConvId);
      expect(receipt.readAt).toBeDefined();
    });

    it("ensures non-participants do NOT receive private messages", async () => {
      let charlieReceived = false;
      const charlieListener = () => {
        charlieReceived = true;
      };
      socketCharlie.on("message:new", charlieListener);

      // Alice sends message to Bob
      await request(app)
        .post(`/api/v1/conversations/${socketConvId}/messages`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "Secret between Alice and Bob" });

      await sleep(200);
      expect(charlieReceived).toBe(false);
      socketCharlie.off("message:new", charlieListener);
    });
  });
});
