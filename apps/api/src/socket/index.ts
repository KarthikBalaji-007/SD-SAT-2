import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { config } from "../config/env.js";
import { redis } from "../config/redis.js";
import { validateToken } from "../middleware/auth.js";
import { ConversationModel } from "../models/conversation.model.js";
import { MessageResponse, SocketMessageNewEvent, SocketMessageReadEvent } from "@connectsphere/shared";

let io: SocketIOServer | null = null;

export interface AuthenticatedSocket extends Socket {
  data: {
    user: {
      id: string;
      username: string;
      displayName: string;
      role: string;
    };
  };
}

export function getSocketServer(): SocketIOServer | null {
  return io;
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.CORS_ORIGIN,
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // Optional Redis Adapter for horizontal scale-out
  try {
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    process.stdout.write(
      JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        service: "socket.io",
        message: "Socket.IO Redis adapter attached for cross-instance messaging",
      }) + "\n"
    );
  } catch (err: unknown) {
    process.stdout.write(
      JSON.stringify({
        level: "warn",
        timestamp: new Date().toISOString(),
        service: "socket.io",
        message: "Failed to initialize Socket.IO Redis adapter, running in single-instance mode",
        error: err instanceof Error ? err.message : String(err),
      }) + "\n"
    );
  }

  // Authentication Middleware for Handshake
  io.use(async (socket, next) => {
    try {
      const authHeader =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization as string | undefined);

      if (!authHeader) {
        return next(new Error("Authentication token required"));
      }

      const token = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7).trim()
        : authHeader.trim();

      const { user } = await validateToken(token);
      (socket as AuthenticatedSocket).data.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      };

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      next(new Error(message));
    }
  });

  io.on("connection", (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    const userId = authSocket.data?.user?.id;

    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // Automatically join private user room
    socket.join(`user:${userId}`);

    // Join conversation room after verifying membership
    socket.on("join:conversation", async (conversationId: string, ack?: (res: any) => void) => {
      try {
        if (!conversationId || typeof conversationId !== "string") {
          const err = { code: "BAD_REQUEST", message: "Invalid conversation ID" };
          socket.emit("error", err);
          if (ack) ack({ error: err });
          return;
        }

        const conversation = await ConversationModel.findById(conversationId);
        if (!conversation || !conversation.participantIds.includes(userId)) {
          const err = { code: "UNAUTHORIZED", message: "Not a participant in this conversation" };
          socket.emit("error", err);
          if (ack) ack({ error: err });
          return;
        }

        await socket.join(`conversation:${conversationId}`);
        if (ack) ack({ conversationId, joined: true });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Failed to join conversation";
        socket.emit("error", { code: "INTERNAL_ERROR", message: errorMsg });
        if (ack) ack({ error: { code: "INTERNAL_ERROR", message: errorMsg } });
      }
    });

    // Leave conversation room
    socket.on("leave:conversation", (conversationId: string) => {
      if (conversationId) {
        socket.leave(`conversation:${conversationId}`);
      }
    });

    socket.on("disconnect", () => {
      // Clean disconnect
    });
  });

  return io;
}

/**
 * Emit a new message to recipient and conversation rooms
 */
export function emitNewMessage(
  message: MessageResponse,
  conversationId: string,
  recipientId: string
): void {
  if (!io) return;

  const eventPayload: SocketMessageNewEvent = { message };

  // Emit to conversation room (for users currently inside the chat window)
  io.to(`conversation:${conversationId}`).emit("message:new", eventPayload);

  // Emit directly to recipient's personal room (for live badges / unread indicators)
  io.to(`user:${recipientId}`).emit("message:new", eventPayload);

  // Emit conversation update to both participants
  io.to(`user:${recipientId}`)
    .to(`user:${message.senderId}`)
    .emit("conversation:updated", {
      conversationId,
      lastMessage: {
        text: message.text,
        senderId: message.senderId,
        createdAt: message.createdAt,
      },
    });
}

/**
 * Emit read status to sender and conversation rooms
 */
export function emitMessageRead(
  messageId: string,
  conversationId: string,
  senderId: string,
  readAt: string
): void {
  if (!io) return;

  const readPayload: SocketMessageReadEvent = {
    messageId,
    conversationId,
    readAt,
  };

  io.to(`conversation:${conversationId}`).emit("message:read", readPayload);
  io.to(`user:${senderId}`).emit("message:read", readPayload);
}
