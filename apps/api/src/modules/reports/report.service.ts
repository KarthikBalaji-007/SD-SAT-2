import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import { PostService } from "../posts/post.service.js";
import {
  CreateReportRequest,
  ReportResponse,
  EventTypes,
} from "@connectsphere/shared";

export class ReportService {
  /**
   * File a report on a post, comment, or user with target visibility verification and outbox event
   */
  static async fileReport(
    reporterId: string,
    reporterRole: string,
    data: CreateReportRequest
  ): Promise<ReportResponse> {
    // 1. Target validation and visibility check
    if (data.targetType === "POST") {
      // Validates post exists and is visible to caller
      await PostService.getPostById(data.targetId, reporterId, reporterRole);
    } else if (data.targetType === "COMMENT") {
      const comment = await prisma.comment.findUnique({
        where: { id: data.targetId },
      });
      if (!comment || comment.status === "DELETED") {
        throw new AppError(404, "NOT_FOUND", "Target comment not found");
      }
      // Ensure caller has access to the parent post
      await PostService.getPostById(comment.postId, reporterId, reporterRole);
    } else if (data.targetType === "USER") {
      if (data.targetId === reporterId) {
        throw new AppError(400, "VALIDATION_ERROR", "Cannot report your own account");
      }
      const targetUser = await prisma.user.findUnique({
        where: { id: data.targetId },
      });
      if (!targetUser) {
        throw new AppError(404, "NOT_FOUND", "Target user not found");
      }
      // If private profile, check if follower or privileged
      if (
        targetUser.privacy === "PRIVATE" &&
        reporterRole !== "MODERATOR" &&
        reporterRole !== "ADMIN"
      ) {
        const follow = await prisma.follow.findUnique({
          where: {
            followerId_followedId: {
              followerId: reporterId,
              followedId: targetUser.id,
            },
          },
        });
        if (!follow) {
          throw new AppError(404, "NOT_FOUND", "Target user not found");
        }
      }
    }

    return await prisma.$transaction(async (tx) => {
      const report = await tx.report.create({
        data: {
          reporterId,
          targetType: data.targetType,
          targetId: data.targetId,
          reason: data.reason,
          status: "PENDING",
        },
        include: {
          reporter: {
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
          eventType: EventTypes.CONTENT_REPORTED,
          aggregateId: report.id,
          payload: {
            reportId: report.id,
            reporterId: report.reporterId,
            targetType: report.targetType,
            targetId: report.targetId,
            reason: report.reason,
            createdAt: report.createdAt.toISOString(),
          },
          createdAt: new Date(),
          attempts: 0,
        },
      });

      return {
        id: report.id,
        reporterId: report.reporterId,
        reporter: {
          id: report.reporter.id,
          username: report.reporter.username,
          displayName: report.reporter.displayName,
          avatarKey: report.reporter.avatarKey,
        },
        targetType: report.targetType,
        targetId: report.targetId,
        reason: report.reason,
        status: report.status,
        moderatorId: report.moderatorId,
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
      };
    });
  }
}
