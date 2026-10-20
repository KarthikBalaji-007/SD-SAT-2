import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { app } from "../apps/api/src/server.js";
import { prisma } from "../apps/api/src/config/prisma.js";
import { redis } from "../apps/api/src/config/redis.js";
import { config } from "../apps/api/src/config/env.js";
import { JwtPayload } from "@connectsphere/shared";

describe("Phase 2A: Authentication and Database Integration Tests", () => {
  const testId = crypto.randomBytes(4).toString("hex");
  const testEmail = `auth_test_${testId}@example.com`;
  const testUsername = `testuser_${testId}`;
  const testPassword = "Password123!";
  const testDisplayName = "Test User";

  let createdUserId: string;
  let validToken: string;

  beforeAll(async () => {
    // Clean up any test records with this specific prefix if present
    await prisma.user.deleteMany({
      where: {
        OR: [{ email: testEmail }, { username: testUsername }],
      },
    });
  });

  afterAll(async () => {
    // Clean up test users created during run
    if (createdUserId) {
      await prisma.user.deleteMany({
        where: { id: createdUserId },
      });
    }
    await prisma.$disconnect();
    await redis.quit().catch(() => redis.disconnect());
  });

  describe("1. Environment Configuration", () => {
    it("should have all required environment variables properly configured", () => {
      expect(config.DATABASE_URL).toBeDefined();
      expect(config.REDIS_URL).toBeDefined();
      expect(config.JWT_SECRET).toBeDefined();
      expect(config.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe("2. User Registration", () => {
    it("should successfully register a new user with valid data", async () => {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: testEmail,
          username: testUsername,
          displayName: testDisplayName,
          password: testPassword,
          bio: "Software developer test bio",
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.email).toBe(testEmail.toLowerCase());
      expect(res.body.data.username).toBe(testUsername.toLowerCase());
      expect(res.body.data.displayName).toBe(testDisplayName);
      expect(res.body.data.role).toBe("USER");
      expect(res.body.data.privacy).toBe("PUBLIC");

      createdUserId = res.body.data.id;

      // Crucial requirement: NEVER return password hash in response
      expect(res.body.data.passwordHash).toBeUndefined();
      expect(res.body.data.password).toBeUndefined();
    });

    it("should store a salted password hash in the database, never plain text", async () => {
      const dbUser = await prisma.user.findUnique({
        where: { id: createdUserId },
      });

      expect(dbUser).not.toBeNull();
      expect(dbUser?.passwordHash).toBeDefined();
      expect(dbUser?.passwordHash).not.toBe(testPassword);
      // bcrypt hashes begin with $2a$ or $2b$
      expect(dbUser?.passwordHash.startsWith("$2")).toBe(true);
    });

    it("should reject duplicate email with HTTP 409 Conflict", async () => {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: testEmail,
          username: `diff_${testId}`,
          displayName: "Different User",
          password: "AnotherPassword123!",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("CONFLICT");
      expect(res.body.error.message).toContain("email");
    });

    it("should reject duplicate username with HTTP 409 Conflict", async () => {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: `diff_${testId}@example.com`,
          username: testUsername,
          displayName: "Different User",
          password: "AnotherPassword123!",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("CONFLICT");
      expect(res.body.error.message).toContain("username");
    });

    it("should reject registration with invalid input with HTTP 400 Validation Error", async () => {
      const res = await request(app)
        .post("/api/v1/auth/register")
        .send({
          email: "not-an-email",
          username: "ab", // too short
          displayName: "",
          password: "short", // < 8 chars
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toBeInstanceOf(Array);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("3. User Login", () => {
    it("should successfully log in with email identifier", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          identifier: testEmail,
          password: testPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.tokenType).toBe("Bearer");
      expect(res.body.data.expiresIn).toBe(900);
      expect(res.body.data.user.id).toBe(createdUserId);
      expect(res.body.data.user.passwordHash).toBeUndefined();

      validToken = res.body.data.accessToken;

      // Verify decoded token claims
      const decoded = jwt.decode(validToken) as JwtPayload;
      expect(decoded.sub).toBe(createdUserId);
      expect(decoded.jti).toBeDefined();
      expect(decoded.role).toBe("USER");
      expect(decoded.username).toBe(testUsername.toLowerCase());
    });

    it("should successfully log in with username identifier", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          identifier: testUsername,
          password: testPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
    });

    it("should reject incorrect password with generic HTTP 401", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          identifier: testEmail,
          password: "WrongPassword999!",
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("should reject non-existent user with generic HTTP 401", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          identifier: "nonexistent_user_99999@example.com",
          password: "SomePassword123!",
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  describe("4. Authentication Middleware & Token Verification", () => {
    it("should reject requests missing Authorization header", async () => {
      const res = await request(app).post("/api/v1/auth/logout");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject malformed or non-Bearer token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", "Bearer invalid-token-string");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("should reject expired token", async () => {
      const expiredToken = jwt.sign(
        {
          sub: createdUserId,
          jti: crypto.randomUUID(),
          role: "USER",
          username: testUsername,
        },
        config.JWT_SECRET,
        { expiresIn: -10 } // already expired
      );

      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TOKEN_EXPIRED");
    });

    it("should reject token with incorrect signature secret", async () => {
      const badSecretToken = jwt.sign(
        {
          sub: createdUserId,
          jti: crypto.randomUUID(),
          role: "USER",
          username: testUsername,
        },
        "wrong_signing_secret_key_1234567890"
      );

      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${badSecretToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
    });

    it("should reject token if user no longer exists in database", async () => {
      const phantomToken = jwt.sign(
        {
          sub: crypto.randomUUID(), // non-existent user id
          jti: crypto.randomUUID(),
          role: "USER",
          username: "phantom",
        },
        config.JWT_SECRET,
        { expiresIn: "15m" }
      );

      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${phantomToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("USER_NOT_FOUND");
    });
  });

  describe("5. Logout & Redis Token Revocation", () => {
    it("should successfully log out with a valid token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Logged out successfully");
    });

    it("should reject subsequent requests with the revoked token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TOKEN_REVOKED");
    });

    it("should have stored the revocation entry in Redis with bounded TTL", async () => {
      const decoded = jwt.decode(validToken) as JwtPayload;
      const isRevoked = await redis.get(`revoked_token:${decoded.jti}`);
      expect(isRevoked).toBe("revoked");

      const ttl = await redis.ttl(`revoked_token:${decoded.jti}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    });
  });

  describe("6. Database Uniqueness & Integrity Constraints", () => {
    it("should reject duplicate email at database level", async () => {
      await expect(
        prisma.user.create({
          data: {
            email: testEmail,
            username: `db_dup_${testId}`,
            displayName: "Dup",
            passwordHash: "hash",
          },
        })
      ).rejects.toThrow();
    });

    it("should reject self-follow at database level via check constraint", async () => {
      await expect(
        prisma.follow.create({
          data: {
            followerId: createdUserId,
            followedId: createdUserId, // self follow
          },
        })
      ).rejects.toThrow();
    });
  });
});
