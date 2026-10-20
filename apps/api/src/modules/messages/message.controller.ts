import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../../middleware/auth.js";
import { MessageService } from "./message.service.js";
import {
  createConversationRequestSchema,
  conversationsPaginationParamsSchema,
  sendMessageRequestSchema,
  messagesPaginationParamsSchema,
} from "@connectsphere/shared";

export class MessageController {
  static async createConversation(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { recipientId } = createConversationRequestSchema.parse(req.body);
      const conversation = await MessageService.getOrCreateConversation(
        req.user!.id,
        recipientId
      );
      res.status(200).json({ data: conversation });
    } catch (err) {
      next(err);
    }
  }

  static async listConversations(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { page, limit } = conversationsPaginationParamsSchema.parse(req.query);
      const result = await MessageService.listConversations(req.user!.id, page, limit);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async listMessages(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { id } = req.params;
      const { cursor, limit } = messagesPaginationParamsSchema.parse(req.query);
      const result = await MessageService.listMessages(req.user!.id, id, cursor, limit);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  static async sendMessage(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { id } = req.params;
      const { text, idempotencyKey } = sendMessageRequestSchema.parse(req.body);
      const message = await MessageService.sendMessage(
        req.user!.id,
        id,
        text,
        idempotencyKey
      );
      res.status(201).json({ data: message, message: "Message sent successfully" });
    } catch (err) {
      next(err);
    }
  }

  static async markAsRead(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { id } = req.params;
      const message = await MessageService.markAsRead(req.user!.id, id);
      res.status(200).json({ data: message, message: "Message marked as read" });
    } catch (err) {
      next(err);
    }
  }
}
