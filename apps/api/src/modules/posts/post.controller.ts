import { Response, NextFunction } from "express";
import { PostService } from "./post.service.js";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { FeedCacheService } from "../../services/feedCache.js";
import {
  createPostRequestSchema,
  updatePostRequestSchema,
  feedPaginationParamsSchema,
} from "@connectsphere/shared";

export class PostController {
  static async createPost(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = createPostRequestSchema.parse(req.body);
      const post = await PostService.createPost(req.user!.id, validated);
      res.status(201).json({ data: post, message: "Post created successfully" });
    } catch (err) {
      next(err);
    }
  }

  static async getOwnPosts(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : 1;
      const limit = req.query.limit ? Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10))) : 20;

      const result = await PostService.getOwnPosts(req.user!.id, page, limit);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getPostById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { postId } = req.params;
      const viewerId = req.user?.id;
      const viewerRole = req.user?.role;

      const post = await PostService.getPostById(postId, viewerId, viewerRole);
      res.status(200).json({ data: post });
    } catch (err) {
      next(err);
    }
  }

  static async updatePost(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { postId } = req.params;
      const validated = updatePostRequestSchema.parse(req.body);

      const updated = await PostService.updatePost(postId, req.user!.id, req.user!.role, validated);
      res.status(200).json({ data: updated, message: "Post updated successfully" });
    } catch (err) {
      next(err);
    }
  }

  static async deletePost(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { postId } = req.params;
      await PostService.deletePost(postId, req.user!.id, req.user!.role);
      res.status(200).json({ message: "Post deleted successfully" });
    } catch (err) {
      next(err);
    }
  }

  static async getFeed(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { cursor, limit } = feedPaginationParamsSchema.parse(req.query);
      const viewerId = req.user!.id;

      // 1. Attempt to serve from Redis feed cache
      const cached = await FeedCacheService.getCachedFeed(viewerId, cursor, limit);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.status(200).json(cached);
        return;
      }

      // 2. Cache miss: fetch from PostgreSQL source of truth
      const feed = await PostService.getPersonalizedFeed(viewerId, cursor, limit);
      res.setHeader("X-Cache", "MISS");

      // 3. Populate Redis feed cache asynchronously
      await FeedCacheService.setCachedFeed(viewerId, feed, cursor, limit);

      res.status(200).json(feed);
    } catch (err) {
      next(err);
    }
  }
}

