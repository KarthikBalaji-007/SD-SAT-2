import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { EventTypes } from "@connectsphere/shared";

describe("Phase 2B2A: Posts and Personalized Feeds Integration Tests", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  let alice: { id: string; email: string; username: string; token: string };
  let bob: { id: string; email: string; username: string; token: string };
  let charlie: { id: string; email: string; username: string; token: string }; // Unrelated user
  let privateDan: { id: string; email: string; username: string; token: string }; // Private profile user

  const createdUserIds: string[] = [];
  const createdPostIds: string[] = [];

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

    alice = await createUser("alice");
    bob = await createUser("bob");
    charlie = await createUser("charlie");
    privateDan = await createUser("privatedan", "USER", "PRIVATE");

    // Alice follows Bob
    await prisma.follow.create({
      data: { followerId: alice.id, followedId: bob.id },
    });
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      if (createdPostIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: {
            aggregateId: { in: createdPostIds },
          },
        });
      }
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

  // ==========================================
  // 1. Post CRUD Operations
  // ==========================================
  describe("1. Post CRUD Operations", () => {
    let createdPostId: string;

    it("POST /posts - authenticated user can create a public post with outbox event", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_CREATED },
      });

      const res = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({
          text: "Hello ConnectSphere! Building scalable microservices.",
          visibility: "PUBLIC",
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.authorId).toBe(alice.id);
      expect(res.body.data.author.username).toBe(alice.username);
      expect(res.body.data.text).toBe("Hello ConnectSphere! Building scalable microservices.");
      expect(res.body.data.visibility).toBe("PUBLIC");
      expect(res.body.data.status).toBe("ACTIVE");
      expect(res.body.data.isAuthor).toBe(true);

      createdPostId = res.body.data.id;
      createdPostIds.push(createdPostId);

      // Verify OutboxEvent recorded atomically
      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_CREATED },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);

      const event = await prisma.outboxEvent.findFirst({
        where: { aggregateId: createdPostId, eventType: EventTypes.POST_CREATED },
      });
      expect(event).not.toBeNull();
      const payload = event?.payload as Record<string, string>;
      expect(payload.authorId).toBe(alice.id);
      expect(payload.postId).toBe(createdPostId);
    });

    it("POST /posts - unauthenticated request is rejected with 401", async () => {
      const res = await request(app)
        .post("/api/v1/posts")
        .send({ text: "Unauthenticated attempt" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /posts - empty or invalid text is rejected with 400", async () => {
      const res = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "   " }); // whitespace only

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("POST /posts - text exceeding 2000 chars is rejected with 400", async () => {
      const res = await request(app)
        .post("/api/v1/posts")
        .set("Authorization", `Bearer ${alice.token}`)
        .send({ text: "a".repeat(2001) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("GET /posts - lists authenticated user's own active posts", async () => {
      const res = await request(app)
        .get("/api/v1/posts")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].authorId).toBe(alice.id);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it("GET /posts/:postId - author can retrieve own post", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdPostId);
      expect(res.body.data.isAuthor).toBe(true);
    });

    it("GET /posts/:postId - anonymous viewer can retrieve public post", async () => {
      const res = await request(app).get(`/api/v1/posts/${createdPostId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdPostId);
      expect(res.body.data.isAuthor).toBe(false);
    });

    it("GET /posts/:postId - invalid Bearer token is rejected (not silently downgraded)", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", "Bearer invalid-tampered-token");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("PATCH /posts/:postId - owner can update text and visibility with outbox event", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_UPDATED },
      });

      const res = await request(app)
        .patch(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({
          text: "Updated content for the post.",
          visibility: "FOLLOWERS_ONLY",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.text).toBe("Updated content for the post.");
      expect(res.body.data.visibility).toBe("FOLLOWERS_ONLY");

      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_UPDATED },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);
    });

    it("PATCH /posts/:postId - rejects modification by unrelated user with 403 Forbidden", async () => {
      const res = await request(app)
        .patch(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${charlie.token}`)
        .send({ text: "Malicious modification attempt" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("PATCH /posts/:postId - rejects immutable or unknown fields", async () => {
      const res = await request(app)
        .patch(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${alice.token}`)
        .send({
          authorId: charlie.id, // cannot reassign author
          status: "DELETED",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("DELETE /posts/:postId - rejects deletion by unrelated user with 403 Forbidden", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("DELETE /posts/:postId - owner can delete post with post.deleted outbox event", async () => {
      const outboxBefore = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_DELETED },
      });

      const res = await request(app)
        .delete(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("deleted");

      // Verify status in DB is marked DELETED
      const postDb = await prisma.post.findUnique({ where: { id: createdPostId } });
      expect(postDb?.status).toBe("DELETED");

      const outboxAfter = await prisma.outboxEvent.count({
        where: { eventType: EventTypes.POST_DELETED },
      });
      expect(outboxAfter).toBe(outboxBefore + 1);
    });

    it("GET /posts/:postId - deleted post returns 404 for ordinary retrieval", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${bob.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("DELETE /posts/:postId - repeated deletion of deleted post returns 404", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${createdPostId}`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  // ==========================================
  // 2. Visibility & Access Policy Tests
  // ==========================================
  describe("2. Visibility and Privacy Policies", () => {
    let bobFollowersOnlyPostId: string;
    let danPrivatePostId: string;

    beforeAll(async () => {
      // Bob creates a FOLLOWERS_ONLY post
      const postB = await prisma.post.create({
        data: {
          authorId: bob.id,
          text: "Bob's exclusive thoughts for followers",
          visibility: "FOLLOWERS_ONLY",
          status: "ACTIVE",
        },
      });
      bobFollowersOnlyPostId = postB.id;
      createdPostIds.push(postB.id);

      // PrivateDan creates a public post
      const postD = await prisma.post.create({
        data: {
          authorId: privateDan.id,
          text: "Dan's private account post",
          visibility: "PUBLIC",
          status: "ACTIVE",
        },
      });
      danPrivatePostId = postD.id;
      createdPostIds.push(postD.id);
    });

    it("GET /posts/:postId - authorized follower (Alice) CAN view Bob's followers-only post", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${bobFollowersOnlyPostId}`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(bobFollowersOnlyPostId);
    });

    it("GET /posts/:postId - unrelated non-follower (Charlie) receives 404 for Bob's followers-only post", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${bobFollowersOnlyPostId}`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /posts/:postId - anonymous viewer receives 404 for Bob's followers-only post", async () => {
      const res = await request(app).get(`/api/v1/posts/${bobFollowersOnlyPostId}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /posts/:postId - non-follower receives 404 for post from private profile account", async () => {
      // Charlie does not follow PrivateDan
      const res = await request(app)
        .get(`/api/v1/posts/${danPrivatePostId}`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("GET /posts/:postId - once following private user, posts become accessible", async () => {
      // Charlie follows PrivateDan
      await prisma.follow.create({
        data: { followerId: charlie.id, followedId: privateDan.id },
      });

      const res = await request(app)
        .get(`/api/v1/posts/${danPrivatePostId}`)
        .set("Authorization", `Bearer ${charlie.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(danPrivatePostId);
    });
  });

  // ==========================================
  // 3. Personalized Feed Tests
  // ==========================================
  describe("3. Personalized Feed (GET /feed)", () => {
    let postAlice1: string;
    let postAlice2: string;
    let postBob1: string;
    let postCharlie: string;

    beforeAll(async () => {
      // Clean up previous posts for clean feed tests
      await prisma.post.deleteMany({
        where: { authorId: { in: createdUserIds } },
      });

      // Post 1: Alice's own post (t0)
      const pA1 = await prisma.post.create({
        data: {
          authorId: alice.id,
          text: "Alice's post 1",
          createdAt: new Date(Date.now() - 30000),
          status: "ACTIVE",
        },
      });
      postAlice1 = pA1.id;

      // Post 2: Bob's post (t1, Bob is followed by Alice)
      const pB = await prisma.post.create({
        data: {
          authorId: bob.id,
          text: "Bob's post for Alice's feed",
          createdAt: new Date(Date.now() - 20000),
          status: "ACTIVE",
        },
      });
      postBob1 = pB.id;

      // Post 3: Charlie's post (t2, Charlie is NOT followed by Alice)
      const pC = await prisma.post.create({
        data: {
          authorId: charlie.id,
          text: "Charlie's unrelated post",
          createdAt: new Date(Date.now() - 10000),
          status: "ACTIVE",
        },
      });
      postCharlie = pC.id;

      // Post 4: Alice's own newer post (t3)
      const pA2 = await prisma.post.create({
        data: {
          authorId: alice.id,
          text: "Alice's post 2 (latest)",
          createdAt: new Date(Date.now()),
          status: "ACTIVE",
        },
      });
      postAlice2 = pA2.id;
    });

    it("GET /feed - unauthenticated access is rejected with 401", async () => {
      const res = await request(app).get("/api/v1/feed");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /feed - includes own posts and followed users' posts, excluding unrelated users", async () => {
      const res = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBe(3); // Alice 2 posts + Bob 1 post

      const postIds = res.body.data.map((p: { id: string }) => p.id);
      expect(postIds).toContain(postAlice2);
      expect(postIds).toContain(postBob1);
      expect(postIds).toContain(postAlice1);
      expect(postIds).not.toContain(postCharlie); // Charlie not followed
    });

    it("GET /feed - orders posts newest first deterministically", async () => {
      const res = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].id).toBe(postAlice2);
      expect(res.body.data[1].id).toBe(postBob1);
      expect(res.body.data[2].id).toBe(postAlice1);
    });

    it("GET /feed - excludes soft-deleted posts from feed", async () => {
      // Soft-delete Bob's post
      await prisma.post.update({
        where: { id: postBob1 },
        data: { status: "DELETED" },
      });

      const res = await request(app)
        .get("/api/v1/feed?limit=10")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      const postIds = res.body.data.map((p: { id: string }) => p.id);
      expect(postIds).not.toContain(postBob1);
      expect(res.body.data.length).toBe(2);

      // Restore Bob's post for pagination test
      await prisma.post.update({
        where: { id: postBob1 },
        data: { status: "ACTIVE" },
      });
    });

    it("GET /feed - cursor pagination navigates pages without duplicates", async () => {
      // Page 1: limit 2
      const resPage1 = await request(app)
        .get("/api/v1/feed?limit=2")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(resPage1.status).toBe(200);
      expect(resPage1.body.data.length).toBe(2);
      expect(resPage1.body.meta.hasMore).toBe(true);
      expect(resPage1.body.meta.nextCursor).toBeDefined();

      const nextCursor = resPage1.body.meta.nextCursor;

      // Page 2: with cursor
      const resPage2 = await request(app)
        .get(`/api/v1/feed?limit=2&cursor=${nextCursor}`)
        .set("Authorization", `Bearer ${alice.token}`);

      expect(resPage2.status).toBe(200);
      expect(resPage2.body.data.length).toBe(1);
      expect(resPage2.body.meta.hasMore).toBe(false);

      // Verify no overlap between page 1 and page 2
      const page1Ids = resPage1.body.data.map((p: { id: string }) => p.id);
      const page2Ids = resPage2.body.data.map((p: { id: string }) => p.id);
      expect(page1Ids).not.toContain(page2Ids[0]);
    });

    it("GET /feed - rejects malformed cursor with 400 Validation Error", async () => {
      const res = await request(app)
        .get("/api/v1/feed?cursor=not-a-valid-cursor")
        .set("Authorization", `Bearer ${alice.token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
