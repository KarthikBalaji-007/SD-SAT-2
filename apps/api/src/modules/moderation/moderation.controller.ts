import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { ModerationService } from "./moderation.service.js";
import {
  moderationReportsQuerySchema,
  resolveReportRequestSchema,
} from "@connectsphere/shared";

export class ModerationController {
  static async listReports(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const filters = moderationReportsQuerySchema.parse(req.query);
      const result = await ModerationService.listReports(filters);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async resolveReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const reportId = req.params.reportId || req.params.id;
      const validatedBody = resolveReportRequestSchema.parse(req.body);
      const updated = await ModerationService.resolveReport(
        reportId,
        req.user!.id,
        validatedBody
      );
      res.status(200).json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
}
