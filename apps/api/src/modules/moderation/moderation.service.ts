import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { AppError } from "../../middleware/errorHandler.js";
import {
  ReportResponse,
  PaginatedResponse,
  ReportStatus,
  ReportTargetType,
  ResolveReportRequest,
  EventTypes,
} from "@connectsphere/shared";
import { FeedCacheService } from "../../services/feedCache.js";


interface ListReportsFilters {
  status?: "PENDING" | "RESOLVED" | "DISMISSED" | "ALL";
  targetType?: ReportTargetType;
  page?: number;
  limit?: number;
}

export class ModerationService {
  /**
   * Retrieve list of reports for moderation queue with status/type filtering and pagination
   */
  static async listReports(
    filters: ListReportsFilters
  ): Promise<PaginatedResponse<ReportResponse>> {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
    const skip = (page - 1) * limit;

    const whereClause: {
      status?: ReportStatus;
      targetType?: ReportTargetType;
    } = {};

    if (filters.status && filters.status !== "ALL") {
      whereClause.status = filters.status as ReportStatus;
    } else if (!filters.status) {
      whereClause.status = "PENDING";
    }

    if (filters.targetType) {
      whereClause.targetType = filters.targetType;
    }

    const [total, reports] = await Promise.all([
      prisma.report.count({ where: whereClause }),
      prisma.report.findMany({
        where: whereClause,
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: limit,
      }),
    ]);

    return {
      data: reports.map((r) => ({
        id: r.id,
        reporterId: r.reporterId,
        reporter: {
          id: r.reporter.id,
          username: r.reporter.username,
          displayName: r.reporter.displayName,
          avatarKey: r.reporter.avatarKey,
        },
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        status: r.status,
        moderatorId: r.moderatorId,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      })),
      meta: {
        page,
        limit,
        total,
        hasMore: skip + reports.length < total,
      },
    };
  }

  /**
   * Review and resolve a report, applying moderation actions and emitting content.moderated atomically
   */
  static async resolveReport(
    reportId: string,
    moderatorId: string,
    data: ResolveReportRequest
  ): Promise<ReportResponse> {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new AppError(404, "NOT_FOUND", "Report not found");
    }

    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          status: data.status,
          moderatorId,
          resolvedAt: now,
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

      // Apply moderation action: content must only be hidden if report is explicitly RESOLVED with HIDE_CONTENT action.
      // Under NO circumstances should DISMISSED reports modify content status.
      if (data.status === "RESOLVED" && data.action === "HIDE_CONTENT") {
        if (report.targetType === "POST") {
          await tx.post.updateMany({
            where: {
              id: report.targetId,
              status: { not: "DELETED" },
            },
            data: { status: "HIDDEN" },
          });

          const post = await tx.post.findUnique({
            where: { id: report.targetId },
            select: { authorId: true },
          });
          if (post) {
            const followers = await tx.follow.findMany({
              where: { followedId: post.authorId },
              select: { followerId: true },
              take: 1000,
            });
            await FeedCacheService.invalidateAuthorAndFollowers(
              post.authorId,
              followers.map((f) => f.followerId)
            );
          }
        } else if (report.targetType === "COMMENT") {

          await tx.comment.updateMany({
            where: {
              id: report.targetId,
              status: { not: "DELETED" },
            },
            data: { status: "HIDDEN" },
          });
        }
      }

      const eventId = crypto.randomUUID();
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: EventTypes.CONTENT_MODERATED,
          aggregateId: report.id,
          payload: {
            reportId: report.id,
            moderatorId,
            targetType: report.targetType,
            targetId: report.targetId,
            status: data.status,
            action: data.action || null,
            notes: data.notes || null,
            resolvedAt: now.toISOString(),
          },
          createdAt: now,
          attempts: 0,
        },
      });

      return {
        id: updated.id,
        reporterId: updated.reporterId,
        reporter: {
          id: updated.reporter.id,
          username: updated.reporter.username,
          displayName: updated.reporter.displayName,
          avatarKey: updated.reporter.avatarKey,
        },
        targetType: updated.targetType,
        targetId: updated.targetId,
        reason: updated.reason,
        status: updated.status,
        moderatorId: updated.moderatorId,
        createdAt: updated.createdAt.toISOString(),
        resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
      };
    });
  }
}
