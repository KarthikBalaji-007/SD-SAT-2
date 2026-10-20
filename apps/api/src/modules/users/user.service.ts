import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  UserProfileResponse,
  UpdateProfileRequest,
  FollowUserResponse,
  FollowListItem,
  PaginatedResponse,
  EventTypes,
} from "@connectsphere/shared";
import { FeedCacheService } from "../../services/feedCache.js";


export class UserService {
  /**
   * Return the authenticated user's own profile
   */
  static async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    if (!user) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      bio: user.bio,
      avatarKey: user.avatarKey,
      privacy: user.privacy,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      followersCount: user._count.followers,
      followingCount: user._count.following,
    };
  }

  /**
   * Update the authenticated user's profile
   */
  static async updateCurrentUser(userId: string, data: UpdateProfileRequest) {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.bio !== undefined && { bio: data.bio }),
        ...(data.avatarKey !== undefined && { avatarKey: data.avatarKey }),
        ...(data.privacy !== undefined && { privacy: data.privacy }),
      },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    return {
      id: updated.id,
      username: updated.username,
      displayName: updated.displayName,
      email: updated.email,
      bio: updated.bio,
      avatarKey: updated.avatarKey,
      privacy: updated.privacy,
      role: updated.role,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      followersCount: updated._count.followers,
      followingCount: updated._count.following,
    };
  }

  /**
   * Get user profile by ID with privacy enforcement
   */
  static async getUserById(
    targetUserId: string,
    viewerId?: string,
    viewerRole?: string
  ): Promise<UserProfileResponse> {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    if (!targetUser) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    // Check if viewer follows target user
    let isFollowing = false;
    if (viewerId && viewerId !== targetUserId) {
      const followRecord = await prisma.follow.findUnique({
        where: {
          followerId_followedId: {
            followerId: viewerId,
            followedId: targetUserId,
          },
        },
      });
      isFollowing = !!followRecord;
    }

    // Privacy rule check
    const isSelf = viewerId === targetUserId;
    const isPrivileged = viewerRole === "MODERATOR" || viewerRole === "ADMIN";

    if (targetUser.privacy === "PRIVATE") {
      // For private accounts, viewer must be self, following, or moderator/admin
      if (!isSelf && !isFollowing && !isPrivileged) {
        // Uniform 404 to avoid leaking existence of private accounts
        throw new AppError(404, "NOT_FOUND", "User not found");
      }
    }

    return {
      id: targetUser.id,
      username: targetUser.username,
      displayName: targetUser.displayName,
      bio: targetUser.bio,
      avatarKey: targetUser.avatarKey,
      privacy: targetUser.privacy,
      role: targetUser.role,
      createdAt: targetUser.createdAt.toISOString(),
      followersCount: targetUser._count.followers,
      followingCount: targetUser._count.following,
      isFollowing,
      isSelf,
    };
  }

  /**
   * Follow a user with transactional outbox event
   */
  static async followUser(followerId: string, followedId: string): Promise<FollowUserResponse> {
    if (followerId === followedId) {
      throw new AppError(400, "VALIDATION_ERROR", "Users cannot follow themselves", [
        { field: "userId", message: "Self-follow is prohibited" },
      ]);
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: followedId },
    });

    if (!targetUser) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    const existingFollow = await prisma.follow.findUnique({
      where: {
        followerId_followedId: { followerId, followedId },
      },
    });

    if (existingFollow) {
      throw new AppError(409, "CONFLICT", "You are already following this user");
    }

    // Atomic transaction: create Follow relation + OutboxEvent
    return await prisma.$transaction(async (tx) => {
      const follow = await tx.follow.create({
        data: {
          followerId,
          followedId,
        },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.FOLLOW_CREATED,
          aggregateId: follow.id,
          payload: {
            followId: follow.id,
            followerId,
            followedId,
            createdAt: follow.createdAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      await FeedCacheService.invalidateUserFeed(followerId);


      return {
        id: follow.id,
        followerId: follow.followerId,
        followedId: follow.followedId,
        createdAt: follow.createdAt.toISOString(),
      };
    });
  }


  /**
   * Unfollow a user with transactional outbox event
   */
  static async unfollowUser(followerId: string, followedId: string): Promise<void> {
    if (followerId === followedId) {
      throw new AppError(400, "VALIDATION_ERROR", "Cannot unfollow self", [
        { field: "userId", message: "Invalid target" },
      ]);
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: followedId },
    });

    if (!targetUser) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    const existingFollow = await prisma.follow.findUnique({
      where: {
        followerId_followedId: { followerId, followedId },
      },
    });

    if (!existingFollow) {
      throw new AppError(404, "NOT_FOUND", "You are not following this user");
    }

    // Atomic transaction: delete Follow relation + OutboxEvent
    await prisma.$transaction(async (tx) => {
      await tx.follow.delete({
        where: { id: existingFollow.id },
      });

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.FOLLOW_DELETED,
          aggregateId: existingFollow.id,
          payload: {
            followId: existingFollow.id,
            followerId,
            followedId,
            deletedAt: new Date().toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      await FeedCacheService.invalidateUserFeed(followerId);
    });
  }


  /**
   * List followers of a user with privacy check & pagination
   */
  static async getFollowers(
    targetUserId: string,
    viewerId?: string,
    viewerRole?: string,
    page = 1,
    limit = 20
  ): Promise<PaginatedResponse<FollowListItem>> {
    // Check target user existence and access permission
    await this.getUserById(targetUserId, viewerId, viewerRole);

    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      prisma.follow.count({
        where: { followedId: targetUserId },
      }),
      prisma.follow.findMany({
        where: { followedId: targetUserId },
        include: {
          follower: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: items.map((f) => ({
        id: f.follower.id,
        username: f.follower.username,
        displayName: f.follower.displayName,
        avatarKey: f.follower.avatarKey,
        followedAt: f.createdAt.toISOString(),
      })),
      meta: {
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
      },
    };
  }

  /**
   * List who a user is following with privacy check & pagination
   */
  static async getFollowing(
    targetUserId: string,
    viewerId?: string,
    viewerRole?: string,
    page = 1,
    limit = 20
  ): Promise<PaginatedResponse<FollowListItem>> {
    // Check target user existence and access permission
    await this.getUserById(targetUserId, viewerId, viewerRole);

    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      prisma.follow.count({
        where: { followerId: targetUserId },
      }),
      prisma.follow.findMany({
        where: { followerId: targetUserId },
        include: {
          followed: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarKey: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: items.map((f) => ({
        id: f.followed.id,
        username: f.followed.username,
        displayName: f.followed.displayName,
        avatarKey: f.followed.avatarKey,
        followedAt: f.createdAt.toISOString(),
      })),
      meta: {
        page,
        limit,
        total,
        hasMore: skip + items.length < total,
      },
    };
  }
}
