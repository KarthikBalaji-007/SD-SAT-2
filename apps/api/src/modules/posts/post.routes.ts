import { Router } from "express";
import { PostController } from "./post.controller.js";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth.js";

import { commentNestedRouter } from "../comments/comment.routes.js";
import { reactionRouter } from "../reactions/reaction.routes.js";

export const postRouter = Router();

postRouter.post("/", authMiddleware, PostController.createPost);
postRouter.get("/", authMiddleware, PostController.getOwnPosts);
postRouter.get("/:postId", optionalAuthMiddleware, PostController.getPostById);
postRouter.patch("/:postId", authMiddleware, PostController.updatePost);
postRouter.delete("/:postId", authMiddleware, PostController.deletePost);

// Mount nested comments and reactions
postRouter.use("/:postId/comments", commentNestedRouter);
postRouter.use("/:postId/reactions", reactionRouter);

export const feedRouter = Router();

feedRouter.get("/", authMiddleware, PostController.getFeed);
