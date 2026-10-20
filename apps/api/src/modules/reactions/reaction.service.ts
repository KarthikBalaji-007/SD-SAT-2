import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import { PostService } from "../posts/post.service.js";
import {
  ReactionType,
  ReactionResponse,
  EventTypes,
} from "@connectsphere/shared";

export class ReactionService {
  /**
   * Add a reaction to an active, visible post with unique constraint enforcement
   */
  static async addReaction(
    postId: string,
    userId: string,
    userRole: string,
    type: ReactionType = "LIKE"
  ): Promise<ReactionResponse> {
    // 1. Verify post exists and is accessible to caller
    const post = await PostService.getPostById(postId, userId, userRole);

    // 2. Check if reaction already exists
    const existing = await prisma.reaction.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    if (existing) {
      throw new AppError(409, "ALREADY_REACTED", "User has already reacted to this post");
    }

    return await prisma.$transaction(async (tx) => {
      const reaction = await tx.reaction.create({
        data: {
          postId,
          userId,
          type,
        },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.REACTION_CREATED,
          aggregateId: reaction.id,
          payload: {
            reactionId: reaction.id,
            postId: reaction.postId,
            postAuthorId: post.authorId,
            userId: reaction.userId,
            type: reaction.type,
            createdAt: reaction.createdAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      return {
        id: reaction.id,
        postId: reaction.postId,
        userId: reaction.userId,
        type: reaction.type,
        createdAt: reaction.createdAt.toISOString(),
      };
    });
  }

  /**
   * Remove a user's reaction from a post
   */
  static async removeReaction(postId: string, userId: string): Promise<void> {
    const reaction = await prisma.reaction.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    if (!reaction) {
      throw new AppError(404, "NOT_FOUND", "Reaction not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.reaction.delete({
        where: { id: reaction.id },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.REACTION_DELETED,
          aggregateId: reaction.id,
          payload: {
            reactionId: reaction.id,
            postId: reaction.postId,
            userId: reaction.userId,
            removedAt: new Date().toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });
    });
  }
}
