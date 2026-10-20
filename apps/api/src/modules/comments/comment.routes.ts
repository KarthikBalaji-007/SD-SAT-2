import { Router } from "express";
import { CommentController } from "./comment.controller.js";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth.js";

export const commentNestedRouter = Router({ mergeParams: true });
export const commentDirectRouter = Router();

// Nested routes under /api/v1/posts/:postId/comments
commentNestedRouter.post("/", authMiddleware, CommentController.createComment);
commentNestedRouter.get("/", optionalAuthMiddleware, CommentController.getPostComments);
commentNestedRouter.delete("/:commentId", authMiddleware, CommentController.deleteComment);

// Direct route under /api/v1/comments/:commentId
commentDirectRouter.delete("/:commentId", authMiddleware, CommentController.deleteComment);
