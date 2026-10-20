import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { config } from "../apps/api/src/config/env.js";
import { EventTypes } from "@connectsphere/shared";

describe("Phase 2B2B: Content Reporting and Moderation Integration Tests", () => {
  const runId = crypto.randomBytes(4).toString("hex");

  let regularUser: { id: string; email: string; username: string; token: string };
  let badActor: { id: string; email: string; username: string; token: string };
  let moderatorUser: { id: string; email: string; username: string; token: string };
  let adminUser: { id: string; email: string; username: string; token: string };

  let offendingPost: { id: string };
  let offendingComment: { id: string };

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

    regularUser = await createUser("regular");
    badActor = await createUser("badactor");
    moderatorUser = await createUser("moderator", "MODERATOR");
    adminUser = await createUser("admin", "ADMIN");

    // Create offending post by badActor
    const post = await prisma.post.create({
      data: {
        authorId: badActor.id,
        text: "Offensive spam content requiring moderation",
        visibility: "PUBLIC",
        status: "ACTIVE",
      },
    });
    offendingPost = { id: post.id };
    createdPostIds.push(post.id);

    // Create offending comment by badActor
    const comment = await prisma.comment.create({
      data: {
        postId: post.id,
        authorId: badActor.id,
        text: "Inappropriate spam comment",
        status: "ACTIVE",
      },
    });
    offendingComment = { id: comment.id };
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

  describe("1. Content Reporting (POST /reports)", () => {
    it("POST /reports - authenticated user can report a post with outbox event", async () => {
      const res = await request(app)
        .post("/api/v1/reports")
        .set("Authorization", `Bearer ${regularUser.token}`)
        .send({
          targetType: "POST",
          targetId: offendingPost.id,
          reason: "Spam and commercial solicitation",
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.targetType).toBe("POST");
      expect(res.body.data.targetId).toBe(offendingPost.id);
      expect(res.body.data.reason).toBe("Spam and commercial solicitation");
      expect(res.body.data.status).toBe("PENDING");
      expect(res.body.data.reporterId).toBe(regularUser.id);

      const reportId = res.body.data.id;

      // Verify outbox event in PostgreSQL
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: reportId,
          eventType: EventTypes.CONTENT_REPORTED,
        },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.reportId).toBe(reportId);
      expect(payload.targetType).toBe("POST");
      expect(payload.targetId).toBe(offendingPost.id);
    });

    it("POST /reports - authenticated user can report a comment", async () => {
      const res = await request(app)
        .post("/api/v1/reports")
        .set("Authorization", `Bearer ${regularUser.token}`)
        .send({
          targetType: "COMMENT",
          targetId: offendingComment.id,
          reason: "Harassment in comments",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.targetType).toBe("COMMENT");
      expect(res.body.data.targetId).toBe(offendingComment.id);
      expect(res.body.data.status).toBe("PENDING");
    });

    it("POST /reports - user cannot report themselves (400 Bad Request)", async () => {
      const res = await request(app)
        .post("/api/v1/reports")
        .set("Authorization", `Bearer ${regularUser.token}`)
        .send({
          targetType: "USER",
          targetId: regularUser.id,
          reason: "Self report",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("POST /reports - returns 404 when target does not exist", async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .post("/api/v1/reports")
        .set("Authorization", `Bearer ${regularUser.token}`)
        .send({
          targetType: "POST",
          targetId: fakeId,
          reason: "Non existent post",
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("POST /reports - unauthenticated request returns 401", async () => {
      const res = await request(app)
        .post("/api/v1/reports")
        .send({
          targetType: "POST",
          targetId: offendingPost.id,
          reason: "Unauthenticated report",
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("2. Moderation Queue and Authorization", () => {
    it("GET /moderation/reports - rejects regular user with 403 Forbidden", async () => {
      const res = await request(app)
        .get("/api/v1/moderation/reports")
        .set("Authorization", `Bearer ${regularUser.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("GET /moderation/reports - allows moderator to list pending reports", async () => {
      const res = await request(app)
        .get("/api/v1/moderation/reports?status=PENDING")
        .set("Authorization", `Bearer ${moderatorUser.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.meta).toBeDefined();

      const postReport = res.body.data.find(
        (r: any) => r.targetId === offendingPost.id
      );
      expect(postReport).toBeDefined();
      expect(postReport.status).toBe("PENDING");
    });

    it("GET /moderation/reports - allows admin to list reports", async () => {
      const res = await request(app)
        .get("/api/v1/moderation/reports")
        .set("Authorization", `Bearer ${adminUser.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("3. Report Resolution and Content Moderation Actions", () => {
    let reportToResolve: any;
    let commentReportToResolve: any;

    beforeAll(async () => {
      // Find reports created in section 1
      reportToResolve = await prisma.report.findFirst({
        where: {
          targetId: offendingPost.id,
          status: "PENDING",
        },
      });

      commentReportToResolve = await prisma.report.findFirst({
        where: {
          targetId: offendingComment.id,
          status: "PENDING",
        },
      });
    });

    it("PATCH /moderation/reports/:reportId - rejects regular user with 403 Forbidden", async () => {
      const res = await request(app)
        .patch(`/api/v1/moderation/reports/${reportToResolve.id}`)
        .set("Authorization", `Bearer ${regularUser.token}`)
        .send({
          status: "RESOLVED",
          action: "HIDE_CONTENT",
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("PATCH /moderation/reports/:reportId - moderator resolves report and hides offending post", async () => {
      const res = await request(app)
        .patch(`/api/v1/moderation/reports/${reportToResolve.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`)
        .send({
          status: "RESOLVED",
          action: "HIDE_CONTENT",
          notes: "Confirmed violation of community guidelines. Content hidden.",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("RESOLVED");
      expect(res.body.data.moderatorId).toBe(moderatorUser.id);
      expect(res.body.data.resolvedAt).not.toBeNull();

      // Verify post status is updated to HIDDEN in database
      const postInDb = await prisma.post.findUnique({
        where: { id: offendingPost.id },
      });
      expect(postInDb!.status).toBe("HIDDEN");

      // Verify regular user receives 404 when querying the moderated post
      const getPostRes = await request(app)
        .get(`/api/v1/posts/${offendingPost.id}`)
        .set("Authorization", `Bearer ${regularUser.token}`);

      expect(getPostRes.status).toBe(404);

      // Verify moderator still can view the post as privileged user
      const modGetPostRes = await request(app)
        .get(`/api/v1/posts/${offendingPost.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`);

      expect(modGetPostRes.status).toBe(200);
      expect(modGetPostRes.body.data.status).toBe("HIDDEN");

      // Verify outbox event content.moderated
      const outbox = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: reportToResolve.id,
          eventType: EventTypes.CONTENT_MODERATED,
        },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox!.payload as any;
      expect(payload.reportId).toBe(reportToResolve.id);
      expect(payload.moderatorId).toBe(moderatorUser.id);
      expect(payload.status).toBe("RESOLVED");
      expect(payload.action).toBe("HIDE_CONTENT");
    });

    it("PATCH /moderation/reports/:reportId - moderator resolves comment report and hides comment", async () => {
      const res = await request(app)
        .patch(`/api/v1/moderation/reports/${commentReportToResolve.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`)
        .send({
          status: "RESOLVED",
          action: "HIDE_CONTENT",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("RESOLVED");

      // Verify comment status is updated to HIDDEN in database
      const commentInDb = await prisma.comment.findUnique({
        where: { id: offendingComment.id },
      });
      expect(commentInDb!.status).toBe("HIDDEN");

      // Verify comment is excluded from post comments listing
      const commentsRes = await request(app)
        .get(`/api/v1/posts/${offendingPost.id}/comments`)
        .set("Authorization", `Bearer ${moderatorUser.token}`);

      expect(commentsRes.status).toBe(200);
      const found = commentsRes.body.data.find(
        (c: any) => c.id === offendingComment.id
      );
      expect(found).toBeUndefined();
    });

    it("PATCH /moderation/reports/:reportId - moderator dismisses a report without altering content", async () => {
      // Create a benign post and report it
      const benignPost = await prisma.post.create({
        data: {
          authorId: regularUser.id,
          text: "Benign discussion post",
          visibility: "PUBLIC",
          status: "ACTIVE",
        },
      });
      createdPostIds.push(benignPost.id);

      const report = await prisma.report.create({
        data: {
          reporterId: badActor.id,
          targetType: "POST",
          targetId: benignPost.id,
          reason: "Frivolous report",
          status: "PENDING",
        },
      });

      const res = await request(app)
        .patch(`/api/v1/moderation/reports/${report.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`)
        .send({
          status: "DISMISSED",
          notes: "No violation detected; dismissing report.",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("DISMISSED");

      // Verify benign post remains ACTIVE
      const postInDb = await prisma.post.findUnique({
        where: { id: benignPost.id },
      });
      expect(postInDb!.status).toBe("ACTIVE");
    });

    it("PATCH /moderation/reports/:reportId - regression: dismissal NEVER alters content status even if action: HIDE_CONTENT is sent", async () => {
      const benignPost2 = await prisma.post.create({
        data: {
          authorId: regularUser.id,
          text: "Another benign post for dismissal regression test",
          visibility: "PUBLIC",
          status: "ACTIVE",
        },
      });
      createdPostIds.push(benignPost2.id);

      const report = await prisma.report.create({
        data: {
          reporterId: badActor.id,
          targetType: "POST",
          targetId: benignPost2.id,
          reason: "Spurious complaint",
          status: "PENDING",
        },
      });

      const res = await request(app)
        .patch(`/api/v1/moderation/reports/${report.id}`)
        .set("Authorization", `Bearer ${moderatorUser.token}`)
        .send({
          status: "DISMISSED",
          action: "HIDE_CONTENT", // Attempt to trick into hiding
          notes: "Dismissing report; content must remain active.",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("DISMISSED");

      // Verify content is NOT hidden
      const postInDb = await prisma.post.findUnique({
        where: { id: benignPost2.id },
      });
      expect(postInDb!.status).toBe("ACTIVE");
    });
  });
});
