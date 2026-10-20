import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { EventTypes } from "@connectsphere/shared";

describe("Phase 2B1: User Profiles and Social Follow Graph Tests", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  // Test users
  let userA: { id: string; email: string; username: string; token: string };
  let userB: { id: string; email: string; username: string; token: string };
  let privateUser: { id: string; email: string; username: string; token: string };
  let moderatorUser: { id: string; email: string; username: string; token: string };

  const createdUserIds: string[] = [];

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
    // Helper to register user
    async function createUser(handle: string, role: "USER" | "MODERATOR" = "USER", privacy: "PUBLIC" | "PRIVATE" = "PUBLIC") {
      const email = `${handle}_${runId}@example.com`;
      const username = `${handle}_${runId}`;
      const dbUser = await prisma.user.create({
        data: {
          email,
          username,
          displayName: `Display ${handle}`,
          passwordHash: "$2b$12$eXampleHashedPasswordForTestOnly99999999999999999999",
          privacy,
          role,
        },
      });
      createdUserIds.push(dbUser.id);
      const token = generateToken(dbUser.id, username, role);
      return { id: dbUser.id, email, username, token };
    }

    userA = await createUser("usera");
    userB = await createUser("userb");
    privateUser = await createUser("userpriv", "USER", "PRIVATE");
    moderatorUser = await createUser("moduser", "MODERATOR", "PUBLIC");
  });

  afterAll(async () => {
    // Cleanup in order
    if (createdUserIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: {
          eventType: { in: [EventTypes.FOLLOW_CREATED, EventTypes.FOLLOW_DELETED] },
        },
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

  // ==========================================
  // 1. User Profile APIs
  // ==========================================
  describe("1. Profile Retrieval (/users/me & /users/:userId)", () => {
    it("GET /users/me - authenticated user can retrieve own profile with email and counts", async () => {
      const res = await request(app)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBe(userA.id);
      expect(res.body.data.email).toBe(userA.email);
      expect(res.body.data.username).toBe(userA.username);
      expect(res.body.data.followersCount).toBe(0);
      expect(res.body.data.followingCount).toBe(0);
      expect(res.body.data.passwordHash).toBeUndefined();
    });

    it("GET /users/me - unauthenticated request is rejected with 401", async () => {
      const res = await request(app).get("/api/v1/users/me");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /users/:userId - can view public user profile without sensitive fields", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${userB.id}`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(userB.id);
      expect(res.body.data.username).toBe(userB.username);
      expect(res.body.data.displayName).toBe("Display userb");
      expect(res.body.data.email).toBeUndefined(); // Email is private
      expect(res.body.data.passwordHash).toBeUndefined();
      expect(res.body.data.isFollowing).toBe(false);
      expect(res.body.data.isSelf).toBe(false);
    });

    it("GET /users/:userId - missing user returns 404", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .get(`/api/v1/users/${fakeId}`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /users/:userId - private profile returns 404 for unrelated viewer (uniform 404)", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${privateUser.id}`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /users/:userId - private profile is accessible to account owner", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${privateUser.id}`)
        .set("Authorization", `Bearer ${privateUser.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(privateUser.id);
      expect(res.body.data.isSelf).toBe(true);
    });

    it("GET /users/:userId - private profile is accessible to moderator", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${privateUser.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(privateUser.id);
    });
  });

  describe("2. Profile Updates (PATCH /users/me)", () => {
    it("PATCH /users/me - successfully updates permitted fields", async () => {
      const res = await request(app)
        .patch("/api/v1/users/me")
        .set("Authorization", `Bearer ${userA.token}`)
        .send({
          displayName: "Updated User A",
          bio: "Senior distributed systems architect",
          avatarKey: "avatars/usera.png",
          privacy: "PRIVATE",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe("Updated User A");
      expect(res.body.data.bio).toBe("Senior distributed systems architect");
      expect(res.body.data.avatarKey).toBe("avatars/usera.png");
      expect(res.body.data.privacy).toBe("PRIVATE");

      // Reset back to public for subsequent tests
      await prisma.user.update({
        where: { id: userA.id },
        data: { privacy: "PUBLIC" },
      });
    });

    it("PATCH /users/me - rejects attempts to modify protected immutable fields", async () => {
      const res = await request(app)
        .patch("/api/v1/users/me")
        .set("Authorization", `Bearer ${userA.token}`)
        .send({
          role: "ADMIN", // protected
          email: "hacked@example.com", // immutable through profile
          passwordHash: "maliciousHash",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("PATCH /users/me - rejects empty update body", async () => {
      const res = await request(app)
        .patch("/api/v1/users/me")
        .set("Authorization", `Bearer ${userA.token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("PATCH /users/me - rejects invalid field constraints", async () => {
      const res = await request(app)
        .patch("/api/v1/users/me")
        .set("Authorization", `Bearer ${userA.token}`)
        .send({
          displayName: "", // empty
          bio: "a".repeat(251), // exceeds 250 limit
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ==========================================
  // 3. Social Follow Graph APIs
  // ==========================================
  describe("3. Follow Graph Operations (/users/:userId/follow)", () => {
    it("POST /users/:userId/follow - rejects self-follow with 400", async () => {
      const res = await request(app)
        .post(`/api/v1/users/${userA.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toContain("Users cannot follow themselves");
    });

    it("POST /users/:userId/follow - rejects following non-existent user with 404", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .post(`/api/v1/users/${fakeId}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("POST /users/:userId/follow - user A successfully follows user B", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_CREATED },
      });

      const res = await request(app)
        .post(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.followerId).toBe(userA.id);
      expect(res.body.data.followedId).toBe(userB.id);

      // Verify DB relationship
      const followDb = await prisma.follow.findUnique({
        where: {
          followerId_followedId: { followerId: userA.id, followedId: userB.id },
        },
      });
      expect(followDb).not.toBeNull();

      // Verify transactional Outbox event was created in same transaction
      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_CREATED },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);

      const outboxRecord = await prisma.outboxEvent.findFirst({
        where: {
          eventType: EventTypes.FOLLOW_CREATED,
          aggregateId: followDb!.id,
        },
      });
      expect(outboxRecord).not.toBeNull();
      const payload = outboxRecord?.payload as Record<string, string>;
      expect(payload.followerId).toBe(userA.id);
      expect(payload.followedId).toBe(userB.id);
    });

    it("POST /users/:userId/follow - duplicate follow is rejected with 409 Conflict", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_CREATED },
      });

      const res = await request(app)
        .post(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");

      // Verify no duplicate outbox event was recorded on rejection
      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_CREATED },
      });
      expect(outboxAfter).toBe(outboxBefore);
    });

    it("GET /users/:userId - user A now sees isFollowing: true for user B", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${userB.id}`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isFollowing).toBe(true);
      expect(res.body.data.followersCount).toBe(1);
    });

    it("GET /users/:userId/followers - lists followers with deterministic pagination", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${userB.id}/followers?page=1&limit=10`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].id).toBe(userA.id);
      expect(res.body.data[0].username).toBe(userA.username);
      expect(res.body.data[0].passwordHash).toBeUndefined();
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.hasMore).toBe(false);
    });

    it("GET /users/:userId/following - lists accounts followed with pagination", async () => {
      const res = await request(app)
        .get(`/api/v1/users/${userA.id}/following?page=1&limit=10`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].id).toBe(userB.id);
      expect(res.body.data[0].username).toBe(userB.username);
      expect(res.body.meta.total).toBe(1);
    });

    it("Following a private user grants access to their profile and follower list", async () => {
      // User B follows privateUser
      await request(app)
        .post(`/api/v1/users/${privateUser.id}/follow`)
        .set("Authorization", `Bearer ${userB.token}`);

      // Now user B can view privateUser's profile
      const resProfile = await request(app)
        .get(`/api/v1/users/${privateUser.id}`)
        .set("Authorization", `Bearer ${userB.token}`);

      expect(resProfile.status).toBe(200);
      expect(resProfile.body.data.id).toBe(privateUser.id);
      expect(resProfile.body.data.isFollowing).toBe(true);

      // And user B can view privateUser's followers
      const resFollowers = await request(app)
        .get(`/api/v1/users/${privateUser.id}/followers`)
        .set("Authorization", `Bearer ${userB.token}`);

      expect(resFollowers.status).toBe(200);
      expect(resFollowers.body.data.length).toBe(1);
      expect(resFollowers.body.data[0].id).toBe(userB.id);
    });

    it("DELETE /users/:userId/follow - user A unfollows user B and creates outbox event", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_DELETED },
      });

      const res = await request(app)
        .delete(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("unfollowed");

      // Verify DB relationship removed
      const followDb = await prisma.follow.findUnique({
        where: {
          followerId_followedId: { followerId: userA.id, followedId: userB.id },
        },
      });
      expect(followDb).toBeNull();

      // Verify outbox record created
      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.FOLLOW_DELETED },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);
    });

    it("DELETE /users/:userId/follow - unfollowing when not following returns 404", async () => {
      const res = await request(app)
        .delete(`/api/v1/users/${userB.id}/follow`)
        .set("Authorization", `Bearer ${userA.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ==========================================
  // 4. Transactional Outbox Tests
  // ==========================================
  describe("4. Transactional Outbox Guarantees", () => {
    it("ensures OutboxEvent records have unpublished state and attempt count 0", async () => {
      const event = await prisma.outboxEvent.findFirst({
        where: { eventType: EventTypes.FOLLOW_CREATED },
        orderBy: { createdAt: "desc" },
      });

      expect(event).not.toBeNull();
      expect(event?.publishedAt).toBeNull();
      expect(event?.attempts).toBe(0);
      expect(event?.aggregateId).toBeDefined();
      expect(event?.payload).toBeDefined();
    });

    it("rolls back outbox event creation if the transaction fails", async () => {
      const failedEventId = crypto.randomUUID();

      // Attempt to execute an aborted transaction simulating relationship insertion failure
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.outboxEvent.create({
            data: {
              id: failedEventId,
              eventType: EventTypes.FOLLOW_CREATED,
              aggregateId: "failed-aggregate",
              payload: { test: true },
              createdAt: new Date(),
              attempts: 0,
            },
          });
          // Intentionally throw inside transaction to trigger rollback
          throw new Error("Simulated transactional failure");
        })
      ).rejects.toThrow("Simulated transactional failure");

      const eventInDb = await prisma.outboxEvent.findUnique({
        where: { id: failedEventId },
      });
      expect(eventInDb).toBeNull();
    });
  });

});

