import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { CommentService } from "./comment.service.js";
import {
  createCommentRequestSchema,
  commentPaginationParamsSchema,
} from "@connectsphere/shared";

export class CommentController {
  static async createComment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const postId = req.params.postId;
      const validatedBody = createCommentRequestSchema.parse(req.body);
      const comment = await CommentService.createComment(
        postId,
        req.user!.id,
        req.user!.role,
        validatedBody
      );
      res.status(201).json({ data: comment });
    } catch (err) {
      next(err);
    }
  }

  static async getPostComments(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const postId = req.params.postId;
      const { page, limit } = commentPaginationParamsSchema.parse(req.query);
      const result = await CommentService.getPostComments(
        postId,
        req.user?.id,
        req.user?.role,
        page,
        limit
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async deleteComment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const commentId = req.params.commentId;
      const postId = req.params.postId;
      await CommentService.deleteComment(
        commentId,
        req.user!.id,
        req.user!.role,
        postId
      );
      res.status(200).json({ message: "Comment deleted successfully" });
    } catch (err) {
      next(err);
    }
  }
}
