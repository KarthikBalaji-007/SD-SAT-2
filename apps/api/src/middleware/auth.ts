import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { AppError } from "./errorHandler.js";
import { LoggedRequest } from "./requestLogger.js";
import { JwtPayload, AuthUserResponse, UserRole } from "@connectsphere/shared";

export interface AuthenticatedRequest extends LoggedRequest {
  user?: AuthUserResponse;
  tokenPayload?: JwtPayload;
  rawToken?: string;
}

export async function validateToken(token: string): Promise<{
  user: AuthUserResponse;
  tokenPayload: JwtPayload;
}> {
  if (!token) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication token required");
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  } catch (err: unknown) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, "TOKEN_EXPIRED", "Authentication token has expired");
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new AppError(401, "INVALID_TOKEN", "Invalid authentication token");
    }
    throw err;
  }

  if (!decoded.jti || !decoded.sub) {
    throw new AppError(401, "INVALID_TOKEN", "Invalid token structure");
  }

  // Check token revocation in Redis (fail-closed if Redis check cannot be completed)
  try {
    const isRevoked = await redis.get(`revoked_token:${decoded.jti}`);
    if (isRevoked) {
      throw new AppError(401, "TOKEN_REVOKED", "Authentication token has been revoked");
    }
  } catch (redisErr) {
    if (redisErr instanceof AppError) {
      throw redisErr;
    }
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Authentication verification temporarily unavailable");
  }

  // Verify user still exists in database
  const user = await prisma.user.findUnique({
    where: { id: decoded.sub },
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

  if (!user) {
    throw new AppError(401, "USER_NOT_FOUND", "User associated with token no longer exists");
  }

  return {
    user: {
      ...user,
      createdAt: user.createdAt.toISOString(),
    },
    tokenPayload: decoded,
  };
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError(401, "UNAUTHORIZED", "Authentication token required"));
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return next(new AppError(401, "UNAUTHORIZED", "Authentication token required"));
  }

  try {
    const { user, tokenPayload } = await validateToken(token);
    req.user = user;
    req.tokenPayload = tokenPayload;
    req.rawToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    // Unauthenticated request, proceed without setting req.user
    return next();
  }

  // An Authorization header was provided; it must be fully validated.
  // Do not silently downgrade invalid, expired, or revoked credentials.
  return authMiddleware(req, res, next);
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, "UNAUTHORIZED", "Authentication required"));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, "FORBIDDEN", "Insufficient permissions to perform this action"));
    }
    next();
  };
}
