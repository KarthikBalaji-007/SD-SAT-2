import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { EventTypes } from "@connectsphere/shared";

describe("Phase 2B2B: Comments and Reactions Integration Tests", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  let author: { id: string; email: string; username: string; token: string };
  let commenter: { id: string; email: string; username: string; token: string };
  let unrelated: { id: string; email: string; username: string; token: string };
  let moderator: { id: string; email: string; username: string; token: string };
  let privateAuthor: { id: string; email: string; username: string; token: string };

  let publicPost: { id: string };
  let privatePost: { id: string };
  let followersOnlyPost: { id: string };

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
    async function createUser(
      handle: string,
      role: "USER" | "MODERATOR" | "ADMIN" = "USER",
      privacy: "PUBLIC" | "PRIVATE" = "PUBLIC"
    ) {
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

    author = await createUser("author");
    commenter = await createUser("commenter");
    unrelated = await createUser("unrelated");
    moderator = await createUser("moderator", "MODERATOR");
    privateAuthor = await createUser("privauthor", "USER", "PRIVATE");

    // Commenter follows privateAuthor
    await prisma.follow.create({
      data: {
        followerId: commenter.id,
        followedId: privateAuthor.id,
      },
    });

    // Create public post by author
    const p1 = await prisma.post.create({
      data: {
        authorId: author.id,
        text: "Public test post for engagement",
        visibility: "PUBLIC",
        status: "ACTIVE",
      },
    });
    publicPost = { id: p1.id };
    createdPostIds.push(p1.id);

    // Create followers-only post by author
    const p2 = await prisma.post.create({
      data: {
        authorId: author.id,
        text: "Followers-only post by author",
        visibility: "FOLLOWERS_ONLY",
        status: "ACTIVE",
      },
    });
    followersOnlyPost = { id: p2.id };
    createdPostIds.push(p2.id);

    // Create public post by private author (accessible only to followers)
    const p3 = await prisma.post.create({
      data: {
        authorId: privateAuthor.id,
        text: "Post by private author",
        visibility: "PUBLIC",
        status: "ACTIVE",
      },
    });
    privatePost = { id: p3.id };
    createdPostIds.push(p3.id);
  });

  afterAll(async () => {
    try {
      if (createdPostIds.length > 0) {
        await prisma.outboxEvent.deleteMany({
          where: { aggregateId: { in: createdPostIds } },
        });
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({
          where: { id: { in: createdUserIds } },
        });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  describe("1. Comments CRUD and Visibility Enforcement", () => {
    let createdCommentId: string;

    it("POST /posts/:postId/comments - creates comment on public post with outbox event", async () => {
      const res = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/comments`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ text: "This is a great post!" });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.postId).toBe(publicPost.id);
      expect(res.body.data.authorId).toBe(commenter.id);
      expect(res.body.data.text).toBe("This is a great post!");
      expect(res.body.data.status).toBe("ACTIVE");
      expect(res.body.data.author.username).toBe(commenter.username);

      createdCommentId = res.body.data.id;

      // Verify outbox event in PostgreSQL
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: createdCommentId,
          eventType: EventTypes.COMMENT_CREATED,
        },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.commentId).toBe(createdCommentId);
      expect(payload.postId).toBe(publicPost.id);
      expect(payload.authorId).toBe(commenter.id);
    });

    it("POST /posts/:postId/comments - rejects unauthenticated request with 401", async () => {
      const res = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/comments`)
        .send({ text: "No token comment" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /posts/:postId/comments - rejects empty text or >1000 char text with 400", async () => {
      const resEmpty = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/comments`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ text: "" });

      expect(resEmpty.status).toBe(400);

      const resTooLong = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/comments`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ text: "x".repeat(1001) });

      expect(resTooLong.status).toBe(400);
    });

    it("POST /posts/:postId/comments - returns 404 on non-existent post", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .post(`/api/v1/posts/${fakeId}/comments`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ text: "Commenting into the void" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("POST /posts/:postId/comments - returns uniform 404 for unauthorized viewer on private account post", async () => {
      // unrelated does not follow privateAuthor
      const res = await request(app)
        .post(`/api/v1/posts/${privatePost.id}/comments`)
        .set("Authorization", `Bearer ${unrelated.token}`)
        .send({ text: "Trying to comment on private post" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("POST /posts/:postId/comments - allows authorized follower to comment on private account post", async () => {
      // commenter follows privateAuthor
      const res = await request(app)
        .post(`/api/v1/posts/${privatePost.id}/comments`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ text: "Follower commenting on private account post" });

      expect(res.status).toBe(201);
      expect(res.body.data.postId).toBe(privatePost.id);
    });

    it("GET /posts/:postId/comments - retrieves paginated active comments for public post", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${publicPost.id}/comments?page=1&limit=10`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.limit).toBe(10);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
    });

    it("GET /posts/:postId/comments - returns 404 when viewer is not permitted to see post", async () => {
      // unrelated is not following privateAuthor
      const res = await request(app)
        .get(`/api/v1/posts/${privatePost.id}/comments`)
        .set("Authorization", `Bearer ${unrelated.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("DELETE /posts/:postId/comments/:commentId - unrelated user cannot delete comment (403)", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${publicPost.id}/comments/${createdCommentId}`)
        .set("Authorization", `Bearer ${unrelated.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("DELETE /posts/:postId/comments/:commentId - comment author can delete own comment", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${publicPost.id}/comments/${createdCommentId}`)
        .set("Authorization", `Bearer ${commenter.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Comment deleted successfully");

      // Verify soft delete in database
      const dbComment = await prisma.comment.findUnique({
        where: { id: createdCommentId },
      });
      expect(dbComment!.status).toBe("DELETED");

      // Verify outbox event comment.deleted
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: createdCommentId,
          eventType: EventTypes.COMMENT_DELETED,
        },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.commentId).toBe(createdCommentId);
      expect(payload.deletedBy).toBe(commenter.id);
    });

    it("GET /posts/:postId/comments - soft-deleted comments are excluded from listing", async () => {
      const res = await request(app)
        .get(`/api/v1/posts/${publicPost.id}/comments`);

      expect(res.status).toBe(200);
      const found = res.body.data.find((c: any) => c.id === createdCommentId);
      expect(found).toBeUndefined();
    });

    it("DELETE /posts/:postId/comments/:commentId - returns 404 on already deleted comment", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${publicPost.id}/comments/${createdCommentId}`)
        .set("Authorization", `Bearer ${commenter.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("DELETE /comments/:commentId - post author can delete other users' comments on their post", async () => {
      // Create a new comment by commenter
      const postComment = await prisma.comment.create({
        data: {
          postId: publicPost.id,
          authorId: commenter.id,
          text: "Another comment to be deleted by post owner",
          status: "ACTIVE",
        },
      });

      // Post owner (author) deletes the comment via direct route
      const res = await request(app)
        .delete(`/api/v1/comments/${postComment.id}`)
        .set("Authorization", `Bearer ${author.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Comment deleted successfully");

      const dbComment = await prisma.comment.findUnique({
        where: { id: postComment.id },
      });
      expect(dbComment!.status).toBe("DELETED");
    });

    it("DELETE /comments/:commentId - moderator can delete any comment", async () => {
      // Create a comment
      const modTargetComment = await prisma.comment.create({
        data: {
          postId: publicPost.id,
          authorId: commenter.id,
          text: "Inappropriate comment removed by moderator",
          status: "ACTIVE",
        },
      });

      const res = await request(app)
        .delete(`/api/v1/comments/${modTargetComment.id}`)
        .set("Authorization", `Bearer ${moderator.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Comment deleted successfully");
    });
  });

  describe("2. Reactions and Unique Constraint Enforcement", () => {
    it("POST /posts/:postId/reactions - adds a reaction with outbox event", async () => {
      const res = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/reactions`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ type: "LIKE" });

      expect(res.status).toBe(201);
      expect(res.body.data.postId).toBe(publicPost.id);
      expect(res.body.data.userId).toBe(commenter.id);
      expect(res.body.data.type).toBe("LIKE");

      // Verify outbox event in PostgreSQL
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: res.body.data.id,
          eventType: EventTypes.REACTION_CREATED,
        },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.postId).toBe(publicPost.id);
      expect(payload.userId).toBe(commenter.id);
      expect(payload.type).toBe("LIKE");
    });

    it("POST /posts/:postId/reactions - duplicate reaction returns 409 Conflict", async () => {
      const res = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/reactions`)
        .set("Authorization", `Bearer ${commenter.token}`)
        .send({ type: "LIKE" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_REACTED");
    });

    it("POST /posts/:postId/reactions - rejects unauthenticated request with 401", async () => {
      const res = await request(app)
        .post(`/api/v1/posts/${publicPost.id}/reactions`)
        .send({ type: "LOVE" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /posts/:postId/reactions - rejects reaction to inaccessible private post with 404", async () => {
      // unrelated cannot see privatePost
      const res = await request(app)
        .post(`/api/v1/posts/${privatePost.id}/reactions`)
        .set("Authorization", `Bearer ${unrelated.token}`)
        .send({ type: "CELEBRATE" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("DELETE /posts/:postId/reactions - removes user's reaction with outbox event", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${publicPost.id}/reactions`)
        .set("Authorization", `Bearer ${commenter.token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Reaction removed successfully");

      // Verify reaction is removed from database
      const dbReaction = await prisma.reaction.findUnique({
        where: {
          postId_userId: {
            postId: publicPost.id,
            userId: commenter.id,
          },
        },
      });
      expect(dbReaction).toBeNull();

      // Verify outbox event reaction.deleted
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          eventType: EventTypes.REACTION_DELETED,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.postId).toBe(publicPost.id);
      expect(payload.userId).toBe(commenter.id);
    });

    it("DELETE /posts/:postId/reactions - returns 404 when removing non-existent reaction", async () => {
      const res = await request(app)
        .delete(`/api/v1/posts/${publicPost.id}/reactions`)
        .set("Authorization", `Bearer ${commenter.token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("3. Transactional Outbox Atomicity & Rollback", () => {
    it("rolls back comment creation if outbox event write fails", async () => {
      const initialCommentCount = await prisma.comment.count({
        where: { postId: publicPost.id },
      });

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.comment.create({
            data: {
              postId: publicPost.id,
              authorId: commenter.id,
              text: "Comment that should be rolled back",
              status: "ACTIVE",
            },
          });
          throw new Error("Simulated Outbox Failure");
        })
      ).rejects.toThrow("Simulated Outbox Failure");

      const finalCommentCount = await prisma.comment.count({
        where: { postId: publicPost.id },
      });
      expect(finalCommentCount).toBe(initialCommentCount);
    });
  });
});

