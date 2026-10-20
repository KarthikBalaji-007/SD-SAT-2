import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  CreatePostRequest,
  UpdatePostRequest,
  PostResponse,
  CursorPaginatedResponse,
  EventTypes,
} from "@connectsphere/shared";
import { FeedCacheService } from "../../services/feedCache.js";


interface PostWithAuthor {
  id: string;
  authorId: string;
  text: string;
  visibility: "PUBLIC" | "FOLLOWERS_ONLY";
  status: "ACTIVE" | "HIDDEN" | "DELETED";
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarKey: string | null;
    privacy?: "PUBLIC" | "PRIVATE";
  };
}

function formatPost(post: PostWithAuthor, viewerId?: string): PostResponse {
  return {
    id: post.id,
    authorId: post.authorId,
    author: {
      id: post.author.id,
      username: post.author.username,
      displayName: post.author.displayName,
      avatarKey: post.author.avatarKey,
    },
    text: post.text,
    visibility: post.visibility,
    status: post.status,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    isAuthor: viewerId === post.authorId,
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  const raw = `${createdAt.toISOString()}#${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAtStr, id] = raw.split("#");
    const date = new Date(createdAtStr);
    if (isNaN(date.getTime()) || !id) {
      throw new Error("Invalid cursor format");
    }
    return { createdAt: date, id };
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid pagination cursor", [
      { field: "cursor", message: "Malformed or invalid cursor provided" },
    ]);
  }
}

export class PostService {
  /**
   * Create a post and record post.created in PostgreSQL OutboxEvent in the same transaction
   */
  static async createPost(authorId: string, data: CreatePostRequest): Promise<PostResponse> {
    return await prisma.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: {
          authorId,
          text: data.text,
          visibility: data.visibility || "PUBLIC",
          status: "ACTIVE",
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          },
        },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.POST_CREATED,
          aggregateId: post.id,
          payload: {
            postId: post.id,
            authorId: post.authorId,
            visibility: post.visibility,
            text: post.text,
            createdAt: post.createdAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      // Invalidate feed caches for author and followers
      const followers = await tx.follow.findMany({
        where: { followedId: post.authorId },
        select: { followerId: true },
        take: 1000,
      });
      await FeedCacheService.invalidateAuthorAndFollowers(
        post.authorId,
        followers.map((f) => f.followerId)
      );

      return formatPost(post, authorId);
    });
  }


  /**
   * List the authenticated user's own active posts with deterministic pagination
   */
  static async getOwnPosts(authorId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [total, posts] = await Promise.all([
      prisma.post.count({
        where: { authorId, status: "ACTIVE" },
      }),
      prisma.post.findMany({
        where: { authorId, status: "ACTIVE" },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: posts.map((p) => formatPost(p, authorId)),
      meta: {
        page,
        limit,
        total,
        hasMore: skip + posts.length < total,
      },
    };
  }

  /**
   * Retrieve a single post with author, privacy, and post visibility rules
   */
  static async getPostById(postId: string, viewerId?: string, viewerRole?: string): Promise<PostResponse> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarKey: true,
            privacy: true,
          },
        },
      },
    });

    if (!post) {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    const isAuthor = viewerId === post.authorId;
    const isPrivileged = viewerRole === "MODERATOR" || viewerRole === "ADMIN";

    // Non-active posts are hidden from ordinary viewers
    if (post.status !== "ACTIVE" && !isAuthor && !isPrivileged) {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    // Determine if viewer is an authorized follower
    let isFollower = false;
    if (viewerId && !isAuthor) {
      const follow = await prisma.follow.findUnique({
        where: {
          followerId_followedId: {
            followerId: viewerId,
            followedId: post.authorId,
          },
        },
      });
      isFollower = !!follow;
    }

    // 1. Author profile privacy policy:
    // If author's profile is PRIVATE, viewer must be author, follower, or moderator/admin
    if (post.author.privacy === "PRIVATE" && !isAuthor && !isFollower && !isPrivileged) {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    // 2. Post visibility policy:
    // If post is FOLLOWERS_ONLY, viewer must be author, follower, or moderator/admin
    if (post.visibility === "FOLLOWERS_ONLY" && !isAuthor && !isFollower && !isPrivileged) {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    return formatPost(post, viewerId);
  }

  /**
   * Update post text and/or visibility with post.updated outbox event
   */
  static async updatePost(
    postId: string,
    userId: string,
    userRole: string,
    data: UpdatePostRequest
  ): Promise<PostResponse> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.status === "DELETED") {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    const isAuthor = post.authorId === userId;
    const isPrivileged = userRole === "MODERATOR" || userRole === "ADMIN";

    if (!isAuthor && !isPrivileged) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to edit this post");
    }

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.post.update({
        where: { id: postId },
        data: {
          ...(data.text !== undefined && { text: data.text }),
          ...(data.visibility !== undefined && { visibility: data.visibility }),
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          },
        },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.POST_UPDATED,
          aggregateId: updated.id,
          payload: {
            postId: updated.id,
            authorId: updated.authorId,
            text: updated.text,
            visibility: updated.visibility,
            updatedAt: updated.updatedAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      // Invalidate feed caches for author and followers
      const followers = await tx.follow.findMany({
        where: { followedId: updated.authorId },
        select: { followerId: true },
        take: 1000,
      });
      await FeedCacheService.invalidateAuthorAndFollowers(
        updated.authorId,
        followers.map((f) => f.followerId)
      );

      return formatPost(updated, userId);
    });
  }

  /**
   * Soft-delete post and record post.deleted in OutboxEvent atomically
   */
  static async deletePost(postId: string, userId: string, userRole: string): Promise<void> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.status === "DELETED") {
      throw new AppError(404, "NOT_FOUND", "Post not found");
    }

    const isAuthor = post.authorId === userId;
    const isPrivileged = userRole === "MODERATOR" || userRole === "ADMIN";

    if (!isAuthor && !isPrivileged) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to delete this post");
    }

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { status: "DELETED" },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.POST_DELETED,
          aggregateId: post.id,
          payload: {
            postId: post.id,
            authorId: post.authorId,
            deletedAt: new Date().toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      // Invalidate feed caches for author and followers
      const followers = await tx.follow.findMany({
        where: { followedId: post.authorId },
        select: { followerId: true },
        take: 1000,
      });
      await FeedCacheService.invalidateAuthorAndFollowers(
        post.authorId,
        followers.map((f) => f.followerId)
      );
    });
  }


  /**
   * Personalized feed for authenticated user with cursor pagination
   */
  static async getPersonalizedFeed(
    viewerId: string,
    cursor?: string,
    limit = 20
  ): Promise<CursorPaginatedResponse<PostResponse>> {
    // 1. Retrieve accounts followed by the viewer
    const follows = await prisma.follow.findMany({
      where: { followerId: viewerId },
      select: { followedId: true },
    });
    const followedIds = follows.map((f) => f.followedId);
    const eligibleAuthorIds = [viewerId, ...followedIds];

    // 2. Decode cursor if provided
    let cursorClause = {};
    if (cursor) {
      const { createdAt: cursorDate, id: cursorId } = decodeCursor(cursor);
      cursorClause = {
        OR: [
          { createdAt: { lt: cursorDate } },
          {
            createdAt: cursorDate,
            id: { lt: cursorId },
          },
        ],
      };
    }

    // 3. Query posts with deterministic ordering and bounded fetch
    const posts = await prisma.post.findMany({
      where: {
        authorId: { in: eligibleAuthorIds },
        status: "ACTIVE",
        ...cursorClause,
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarKey: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = posts.length > limit;
    const items = hasMore ? posts.slice(0, limit) : posts;

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
        : null;

    return {
      data: items.map((p) => formatPost(p, viewerId)),
      meta: {
        limit,
        nextCursor,
        hasMore,
      },
    };
  }
}
