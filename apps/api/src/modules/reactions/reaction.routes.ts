import { Router } from "express";
import { ReactionController } from "./reaction.controller.js";
import { authMiddleware } from "../../middleware/auth.js";

export const reactionRouter = Router({ mergeParams: true });

// Nested routes under /api/v1/posts/:postId/reactions
reactionRouter.post("/", authMiddleware, ReactionController.addReaction);
reactionRouter.delete("/", authMiddleware, ReactionController.removeReaction);
