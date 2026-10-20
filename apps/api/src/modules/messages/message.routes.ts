import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { MessageController } from "./message.controller.js";

export const conversationRouter = Router();
export const messageDirectRouter = Router();

// Conversation routes: mounted at /api/v1/conversations
conversationRouter.use(authMiddleware);
conversationRouter.post("/", MessageController.createConversation);
conversationRouter.get("/", MessageController.listConversations);
conversationRouter.get("/:id/messages", MessageController.listMessages);
conversationRouter.post("/:id/messages", MessageController.sendMessage);

// Direct message action routes: mounted at /api/v1/messages
messageDirectRouter.use(authMiddleware);
messageDirectRouter.patch("/:id/read", MessageController.markAsRead);
