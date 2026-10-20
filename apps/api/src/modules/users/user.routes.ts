import { Router } from "express";
import { UserController } from "./user.controller.js";
import { authMiddleware, optionalAuthMiddleware } from "../../middleware/auth.js";

export const userRouter = Router();

// Authenticated user's own profile routes (declared before /:userId)
userRouter.get("/me", authMiddleware, UserController.getMe);
userRouter.patch("/me", authMiddleware, UserController.updateMe);

// Public or privacy-guarded user profile route
userRouter.get("/:userId", optionalAuthMiddleware, UserController.getUser);

// Social follow graph routes
userRouter.post("/:userId/follow", authMiddleware, UserController.followUser);
userRouter.delete("/:userId/follow", authMiddleware, UserController.unfollowUser);
userRouter.get("/:userId/followers", optionalAuthMiddleware, UserController.getFollowers);
userRouter.get("/:userId/following", optionalAuthMiddleware, UserController.getFollowing);
