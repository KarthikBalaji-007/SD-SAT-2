import mongoose from "mongoose";
import crypto from "crypto";
import { prisma } from "../../config/prisma.js";
import { connectMongo } from "../../config/mongo.js";
import { ConversationModel, buildParticipantPairKey } from "../../models/conversation.model.js";
import { MessageModel, IMessage } from "../../models/message.model.js";
import { AppError } from "../../middleware/errorHandler.js";
import { emitNewMessage, emitMessageRead } from "../../socket/index.js";
import {
  ConversationResponse,
  MessageResponse,
  CursorPaginatedResponse,
  ParticipantSummary,
} from "@connectsphere/shared";

export class MessageService {
  /**
   * Find or create a one-to-one conversation between authenticated user and recipient
   */
  static async getOrCreateConversation(
    userId: string,
    recipientId: string
  ): Promise<ConversationResponse> {
    await connectMongo();

    if (userId === recipientId) {
      throw new AppError(400, "BAD_REQUEST", "Self-conversation is not permitted");
    }

    // Verify recipient user exists in PostgreSQL
    const recipient = await prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, username: true, displayName: true, avatarKey: true },
    });

    if (!recipient) {
      throw new AppError(404, "USER_NOT_FOUND", "Recipient user does not exist");
    }

    const participantPairKey = buildParticipantPairKey(userId, recipientId);

    let conversation = await ConversationModel.findOne({ participantPairKey });
    if (!conversation) {
      try {
        conversation = await ConversationModel.create({
          participantIds: [userId, recipientId],
          participantPairKey,
        });
      } catch (err: any) {
        if (err.code === 11000) {
          // Handled concurrent creation race condition
          conversation = await ConversationModel.findOne({ participantPairKey });
        } else {
          throw err;
        }
      }
    }

    if (!conversation) {
      throw new AppError(500, "INTERNAL_ERROR", "Failed to retrieve or create conversation");
    }

    return this.formatConversation(conversation);
  }

  /**
   * List conversations for the authenticated user, ordered by most recent activity
   */
  static async listConversations(
    userId: string,
    page = 1,
    limit = 20
  ): Promise<{ data: ConversationResponse[]; meta: any }> {
    await connectMongo();

    const skip = (page - 1) * limit;

    const [total, conversations] = await Promise.all([
      ConversationModel.countDocuments({ participantIds: userId }),
      ConversationModel.find({ participantIds: userId })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    // Batch retrieve all participants for found conversations
    const allParticipantIds = [
      ...new Set(conversations.flatMap((c) => c.participantIds)),
    ];

    const users =
      allParticipantIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: allParticipantIds } },
            select: { id: true, username: true, displayName: true, avatarKey: true },
          })
        : [];

    const userMap = new Map(users.map((u) => [u.id, u]));

    const data: ConversationResponse[] = conversations.map((c) => {
      const participants: ParticipantSummary[] = c.participantIds
        .map((pid) => userMap.get(pid))
        .filter(Boolean) as ParticipantSummary[];

      return {
        id: c._id.toString(),
        participantIds: c.participantIds,
        participants,
        lastMessage:
          c.lastMessageText && c.lastMessageSenderId && c.lastMessageAt
            ? {
                text: c.lastMessageText,
                senderId: c.lastMessageSenderId,
                createdAt: c.lastMessageAt.toISOString(),
              }
            : null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });

    return {
      data,
      meta: {
        page,
        limit,
        total,
        hasMore: skip + conversations.length < total,
      },
    };
  }

  /**
   * Retrieve messages in a conversation using cursor pagination (newest first)
   */
  static async listMessages(
    userId: string,
    conversationId: string,
    cursor?: string,
    limit = 50
  ): Promise<CursorPaginatedResponse<MessageResponse>> {
    await connectMongo();

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      throw new AppError(404, "NOT_FOUND", "Conversation not found");
    }

    const conversation = await ConversationModel.findById(conversationId);
    if (!conversation || !conversation.participantIds.includes(userId)) {
      throw new AppError(404, "NOT_FOUND", "Conversation not found");
    }

    const filter: Record<string, unknown> = { conversationId };

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, "base64").toString("utf8");
        const [createdAtIso, messageId] = decoded.split("#");
        const cursorDate = new Date(createdAtIso);

        filter.$or = [
          { createdAt: { $lt: cursorDate } },
          {
            createdAt: cursorDate,
            _id: { $lt: new mongoose.Types.ObjectId(messageId) },
          },
        ];
      } catch {
        throw new AppError(400, "BAD_REQUEST", "Invalid pagination cursor");
      }
    }

    const messages = await MessageModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasMore = messages.length > limit;
    const dataItems = hasMore ? messages.slice(0, limit) : messages;

    // Fetch sender profiles from PostgreSQL
    const senderIds = [...new Set(dataItems.map((m) => m.senderId))];
    const senders =
      senderIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, username: true, displayName: true, avatarKey: true },
          })
        : [];
    const senderMap = new Map(senders.map((s) => [s.id, s]));

    const data: MessageResponse[] = dataItems.map((m) => ({
      id: m._id.toString(),
      conversationId: m.conversationId,
      senderId: m.senderId,
      recipientId: m.recipientId,
      sender: senderMap.get(m.senderId),
      text: m.text,
      readAt: m.readAt ? m.readAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
    }));

    let nextCursor: string | undefined;
    if (hasMore && dataItems.length > 0) {
      const last = dataItems[dataItems.length - 1];
      nextCursor = Buffer.from(`${last.createdAt.toISOString()}#${last._id.toString()}`).toString(
        "base64"
      );
    }

    return {
      data,
      meta: {
        limit,
        nextCursor,
        hasMore,
      },
    };
  }

  /**
   * Send a message in a conversation with durable outbox state and real-time delivery
   */
  static async sendMessage(
    senderId: string,
    conversationId: string,
    text: string,
    idempotencyKey?: string
  ): Promise<MessageResponse> {
    await connectMongo();

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      throw new AppError(404, "NOT_FOUND", "Conversation not found");
    }

    const conversation = await ConversationModel.findById(conversationId);
    if (!conversation || !conversation.participantIds.includes(senderId)) {
      throw new AppError(404, "NOT_FOUND", "Conversation not found");
    }

    // Idempotency check for client retries
    if (idempotencyKey) {
      const existing = await MessageModel.findOne({ senderId, idempotencyKey });
      if (existing) {
        return this.formatSingleMessage(existing);
      }
    }

    const recipientId = conversation.participantIds.find((id) => id !== senderId);
    if (!recipientId) {
      throw new AppError(400, "BAD_REQUEST", "Unable to resolve recipient");
    }

    const eventId = crypto.randomUUID();

    const message = await MessageModel.create({
      conversationId,
      senderId,
      recipientId,
      text,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      publication: {
        eventId,
        publishedAt: null,
        attempts: 0,
        lastAttemptAt: null,
        retryAfter: null,
        lastError: null,
      },
    });

    // Update conversation's last message activity metadata
    conversation.lastMessageText = text;
    conversation.lastMessageSenderId = senderId;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    const formatted = await this.formatSingleMessage(message);

    // Deliver via Socket.IO after durable MongoDB persistence
    emitNewMessage(formatted, conversationId, recipientId);

    return formatted;
  }

  /**
   * Mark a message as read by the recipient
   */
  static async markAsRead(userId: string, messageId: string): Promise<MessageResponse> {
    await connectMongo();

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      throw new AppError(404, "NOT_FOUND", "Message not found");
    }

    const message = await MessageModel.findById(messageId);
    if (!message || message.recipientId !== userId) {
      throw new AppError(404, "NOT_FOUND", "Message not found");
    }

    if (!message.readAt) {
      message.readAt = new Date();
      await message.save();

      // Emit real-time read event to sender and conversation
      emitMessageRead(
        message._id.toString(),
        message.conversationId,
        message.senderId,
        message.readAt.toISOString()
      );
    }

    return this.formatSingleMessage(message);
  }

  private static async formatConversation(conv: any): Promise<ConversationResponse> {
    const users = await prisma.user.findMany({
      where: { id: { in: conv.participantIds } },
      select: { id: true, username: true, displayName: true, avatarKey: true },
    });

    return {
      id: conv._id.toString(),
      participantIds: conv.participantIds,
      participants: users,
      lastMessage:
        conv.lastMessageText && conv.lastMessageSenderId && conv.lastMessageAt
          ? {
              text: conv.lastMessageText,
              senderId: conv.lastMessageSenderId,
              createdAt: conv.lastMessageAt.toISOString(),
            }
          : null,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    };
  }

  private static async formatSingleMessage(msg: IMessage): Promise<MessageResponse> {
    const sender = await prisma.user.findUnique({
      where: { id: msg.senderId },
      select: { id: true, username: true, displayName: true, avatarKey: true },
    });

    return {
      id: msg._id.toString(),
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      recipientId: msg.recipientId,
      sender: sender || undefined,
      text: msg.text,
      readAt: msg.readAt ? msg.readAt.toISOString() : null,
      createdAt: msg.createdAt.toISOString(),
    };
  }
}
