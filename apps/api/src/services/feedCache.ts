import { redis } from "../config/redis.js";
import { prisma } from "../config/prisma.js";
import { CursorPaginatedResponse, PostResponse } from "@connectsphere/shared";

const DEFAULT_FEED_TTL_SECONDS = 60;

export class FeedCacheService {
  /**
   * Retrieve viewer's current feed version to guarantee versioned cache isolation
   */
  static async getFeedVersion(viewerId: string): Promise<string> {
    try {
      const version = await redis.get(`user:feed_version:${viewerId}`);
      return version || "1";
    } catch (err) {
      return "1";
    }
  }

  /**
   * Build scoped cache key
   */
  static buildCacheKey(
    viewerId: string,
    version: string,
    cursor?: string,
    limit = 20
  ): string {
    const cursorPart = cursor || "initial";
    return `feed:${viewerId}:v${version}:${cursorPart}:${limit}`;
  }

  /**
   * Fetch cached feed response safely; falls back to null on cache miss or Redis failure.
   * Strictly enforces that cached posts are currently ACTIVE to ensure caching never bypasses
   * visibility, deletion, or moderation policy.
   */
  static async getCachedFeed(
    viewerId: string,
    cursor?: string,
    limit = 20
  ): Promise<CursorPaginatedResponse<PostResponse> | null> {
    try {
      const version = await this.getFeedVersion(viewerId);
      const key = this.buildCacheKey(viewerId, version, cursor, limit);
      const raw = await redis.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as CursorPaginatedResponse<PostResponse>;
      if (!parsed || !Array.isArray(parsed.data) || !parsed.meta) {
        return null;
      }

      // Verification: ensure no soft-deleted or moderated post is served from cache
      const postIds = parsed.data.map((p) => p.id);
      if (postIds.length > 0) {
        const activeCount = await prisma.post.count({
          where: { id: { in: postIds }, status: "ACTIVE" },
        });
        if (activeCount !== postIds.length) {
          // Stale cache detected: invalidate and fall back to PostgreSQL
          await this.invalidateUserFeed(viewerId);
          return null;
        }
      }

      return parsed;
    } catch (err: unknown) {

      process.stderr.write(
        JSON.stringify({
          level: "warn",
          timestamp: new Date().toISOString(),
          service: "feed-cache",
          message: "Failed to read feed from Redis, falling back to PostgreSQL",
          viewerId,
          error: err instanceof Error ? err.message : String(err),
        }) + "\n"
      );
      return null;
    }
  }

  /**
   * Store feed response in cache with short TTL
   */
  static async setCachedFeed(
    viewerId: string,
    data: CursorPaginatedResponse<PostResponse>,
    cursor?: string,
    limit = 20,
    ttlSeconds = DEFAULT_FEED_TTL_SECONDS
  ): Promise<void> {
    try {
      const version = await this.getFeedVersion(viewerId);
      const key = this.buildCacheKey(viewerId, version, cursor, limit);
      await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
    } catch {
      // Non-critical, ignore write errors
    }
  }

  /**
   * Invalidate a single user's feed cache in O(1) by incrementing feed version
   */
  static async invalidateUserFeed(userId: string): Promise<void> {
    try {
      await redis.incr(`user:feed_version:${userId}`);
    } catch {
      // Non-critical, ignore
    }
  }

  /**
   * Invalidate feeds for an author and their followers using a pipeline
   */
  static async invalidateAuthorAndFollowers(
    authorId: string,
    followerIds: string[]
  ): Promise<void> {
    try {
      const pipeline = redis.pipeline();
      pipeline.incr(`user:feed_version:${authorId}`);
      for (const fid of followerIds) {
        pipeline.incr(`user:feed_version:${fid}`);
      }
      await pipeline.exec();
    } catch {
      // Non-critical, ignore
    }
  }
}
