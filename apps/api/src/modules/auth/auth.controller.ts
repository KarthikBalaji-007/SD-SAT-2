import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { redis } from "../../config/redis.js";
import { config } from "../../config/env.js";
import { AppError } from "../../middleware/errorHandler.js";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import {
  registerRequestSchema,
  loginRequestSchema,
  JwtPayload,
} from "@connectsphere/shared";

const TOKEN_EXPIRY_SECONDS = 900; // 15 minutes

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = registerRequestSchema.parse(req.body);
      const email = validated.email.toLowerCase().trim();
      const username = validated.username.toLowerCase().trim();

      // Check for duplicate email or username
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ email }, { username }],
        },
      });

      if (existingUser) {
        const conflictField = existingUser.email === email ? "email" : "username";
        return next(
          new AppError(409, "CONFLICT", `A user with this ${conflictField} already exists`, [
            { field: conflictField, message: `This ${conflictField} is already registered` },
          ])
        );
      }

      // Hash password
      const passwordHash = await bcrypt.hash(validated.password, 12);

      // Persist user
      const user = await prisma.user.create({
        data: {
          username,
          email,
          displayName: validated.displayName.trim(),
          passwordHash,
          bio: validated.bio?.trim() || null,
          avatarKey: validated.avatarKey || null,
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          bio: true,
          avatarKey: true,
          privacy: true,
          role: true,
          createdAt: true,
        },
      });

      res.status(201).json({
        data: {
          ...user,
          createdAt: user.createdAt.toISOString(),
        },
        message: "User registered successfully",
      });
    } catch (err) {
      next(err);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = loginRequestSchema.parse(req.body);
      const identifier = validated.identifier.toLowerCase().trim();

      const user = await prisma.user.findFirst({
        where: {
          OR: [{ email: identifier }, { username: identifier }],
        },
      });

      if (!user) {
        return next(
          new AppError(401, "INVALID_CREDENTIALS", "Invalid email/username or password")
        );
      }

      const isPasswordValid = await bcrypt.compare(validated.password, user.passwordHash);
      if (!isPasswordValid) {
        return next(
          new AppError(401, "INVALID_CREDENTIALS", "Invalid email/username or password")
        );
      }

      const jti = crypto.randomUUID();
      const payload: JwtPayload = {
        sub: user.id,
        jti,
        role: user.role,
        username: user.username,
      };

      const accessToken = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: TOKEN_EXPIRY_SECONDS,
      });

      res.status(200).json({
        data: {
          accessToken,
          tokenType: "Bearer",
          expiresIn: TOKEN_EXPIRY_SECONDS,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            bio: user.bio,
            avatarKey: user.avatarKey,
            privacy: user.privacy,
            role: user.role,
            createdAt: user.createdAt.toISOString(),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.tokenPayload?.jti) {
        return next(new AppError(401, "UNAUTHORIZED", "Missing token claims"));
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const exp = req.tokenPayload.exp || nowSeconds + TOKEN_EXPIRY_SECONDS;
      const ttl = Math.max(1, exp - nowSeconds);

      // Record token revocation in Redis with TTL bounded by token expiration
      await redis.set(`revoked_token:${req.tokenPayload.jti}`, "revoked", "EX", ttl);

      res.status(200).json({
        message: "Logged out successfully",
      });
    } catch (err) {
      next(err);
    }
  }
}
