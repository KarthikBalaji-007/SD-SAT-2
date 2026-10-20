import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { ReportService } from "./report.service.js";
import { createReportRequestSchema } from "@connectsphere/shared";

export class ReportController {
  static async fileReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const validatedBody = createReportRequestSchema.parse(req.body);
      const report = await ReportService.fileReport(
        req.user!.id,
        req.user!.role,
        validatedBody
      );
      res.status(201).json({ data: report });
    } catch (err) {
      next(err);
    }
  }
}
