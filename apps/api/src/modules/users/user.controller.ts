import { Response, NextFunction } from "express";
import { UserService } from "./user.service.js";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import {
  updateProfileRequestSchema,
  followPaginationParamsSchema,
} from "@connectsphere/shared";

export class UserController {
  static async getMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const profile = await UserService.getCurrentUser(req.user!.id);
      res.status(200).json({ data: profile });
    } catch (err) {
      next(err);
    }
  }

  static async updateMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = updateProfileRequestSchema.parse(req.body);
      const updated = await UserService.updateCurrentUser(req.user!.id, validated);
      res.status(200).json({ data: updated, message: "Profile updated successfully" });
    } catch (err) {
      next(err);
    }
  }

  static async getUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const viewerId = req.user?.id;
      const viewerRole = req.user?.role;

      const profile = await UserService.getUserById(userId, viewerId, viewerRole);
      res.status(200).json({ data: profile });
    } catch (err) {
      next(err);
    }
  }

  static async followUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId: followedId } = req.params;
      const followerId = req.user!.id;

      const result = await UserService.followUser(followerId, followedId);
      res.status(201).json({
        data: result,
        message: "Successfully followed user",
      });
    } catch (err) {
      next(err);
    }
  }

  static async unfollowUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId: followedId } = req.params;
      const followerId = req.user!.id;

      await UserService.unfollowUser(followerId, followedId);
      res.status(200).json({
        message: "Successfully unfollowed user",
      });
    } catch (err) {
      next(err);
    }
  }

  static async getFollowers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { page, limit } = followPaginationParamsSchema.parse(req.query);
      const viewerId = req.user?.id;
      const viewerRole = req.user?.role;

      const result = await UserService.getFollowers(userId, viewerId, viewerRole, page, limit);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getFollowing(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { page, limit } = followPaginationParamsSchema.parse(req.query);
      const viewerId = req.user?.id;
      const viewerRole = req.user?.role;

      const result = await UserService.getFollowing(userId, viewerId, viewerRole, page, limit);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}
