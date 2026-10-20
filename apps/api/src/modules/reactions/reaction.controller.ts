import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { ReactionService } from "./reaction.service.js";
import { createReactionRequestSchema } from "@connectsphere/shared";

export class ReactionController {
  static async addReaction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const postId = req.params.postId;
      const { type } = createReactionRequestSchema.parse(req.body || {});
      const reaction = await ReactionService.addReaction(
        postId,
        req.user!.id,
        req.user!.role,
        type
      );
      res.status(201).json({ data: reaction });
    } catch (err) {
      next(err);
    }
  }

  static async removeReaction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const postId = req.params.postId;
      await ReactionService.removeReaction(postId, req.user!.id);
      res.status(200).json({ message: "Reaction removed successfully" });
    } catch (err) {
      next(err);
    }
  }
}
