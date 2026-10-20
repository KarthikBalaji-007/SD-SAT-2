import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import { PostService } from "../posts/post.service.js";
import {
  CreateCommentRequest,
  CommentResponse,
  PaginatedResponse,
  EventTypes,
} from "@connectsphere/shared";

export class CommentService {
  /**
   * Add a comment to an active, visible post with transactional outbox emission
   */
  static async createComment(
    postId: string,
    authorId: string,
    authorRole: string,
    data: CreateCommentRequest
  ): Promise<CommentResponse> {
    // 1. Verify post exists and is visible to the caller
    const post = await PostService.getPostById(postId, authorId, authorRole);

    return await prisma.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          postId,
          authorId,
          text: data.text,
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
          eventType: EventTypes.COMMENT_CREATED,
          aggregateId: comment.id,
          payload: {
            commentId: comment.id,
            postId: comment.postId,
            postAuthorId: post.authorId,
            authorId: comment.authorId,
            text: comment.text,
            createdAt: comment.createdAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      return {
        id: comment.id,
        postId: comment.postId,
        authorId: comment.authorId,
        author: {
          id: comment.author.id,
          username: comment.author.username,
          displayName: comment.author.displayName,
          avatarKey: comment.author.avatarKey,
        },
        text: comment.text,
        status: comment.status,
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
        isAuthor: true,
      };
    });
  }

  /**
   * List active comments for a visible post with pagination
   */
  static async getPostComments(
    postId: string,
    viewerId?: string,
    viewerRole?: string,
    page = 1,
    limit = 20
  ): Promise<PaginatedResponse<CommentResponse>> {
    // 1. Verify post exists and is accessible to viewer
    await PostService.getPostById(postId, viewerId, viewerRole);

    const skip = (page - 1) * limit;

    const [total, comments] = await Promise.all([
      prisma.comment.count({
        where: { postId, status: "ACTIVE" },
      }),
      prisma.comment.findMany({
        where: { postId, status: "ACTIVE" },
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: comments.map((c) => ({
        id: c.id,
        postId: c.postId,
        authorId: c.authorId,
        author: {
          id: c.author.id,
          username: c.author.username,
          displayName: c.author.displayName,
          avatarKey: c.author.avatarKey,
        },
        text: c.text,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        isAuthor: viewerId === c.authorId,
      })),
      meta: {
        page,
        limit,
        total,
        hasMore: skip + comments.length < total,
      },
    };
  }

  /**
   * Delete a comment (by comment author, post author, or moderator/admin)
   */
  static async deleteComment(
    commentId: string,
    userId: string,
    userRole: string,
    postId?: string
  ): Promise<void> {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        post: {
          select: {
            id: true,
            authorId: true,
          },
        },
      },
    });

    if (!comment || comment.status === "DELETED") {
      throw new AppError(404, "NOT_FOUND", "Comment not found");
    }

    if (postId && comment.postId !== postId) {
      throw new AppError(404, "NOT_FOUND", "Comment not found on this post");
    }

    const isCommentAuthor = comment.authorId === userId;
    const isPostAuthor = comment.post.authorId === userId;
    const isPrivileged = userRole === "MODERATOR" || userRole === "ADMIN";

    if (!isCommentAuthor && !isPostAuthor && !isPrivileged) {
      throw new AppError(403, "FORBIDDEN", "You do not have permission to delete this comment");
    }

    await prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: commentId },
        data: { status: "DELETED" },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.COMMENT_DELETED,
          aggregateId: comment.id,
          payload: {
            commentId: comment.id,
            postId: comment.postId,
            authorId: comment.authorId,
            deletedBy: userId,
            deletedAt: new Date().toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });
    });
  }
}
