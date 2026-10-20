import { Router } from "express";
import { ReportController } from "./report.controller.js";
import { authMiddleware } from "../../middleware/auth.js";

export const reportRouter = Router();

// Route under /api/v1/reports
reportRouter.post("/", authMiddleware, ReportController.fileReport);
