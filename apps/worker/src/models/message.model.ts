import mongoose, { Schema, Document, Model } from "mongoose";

export interface IMessagePublication {
  eventId: string;
  publishedAt: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
  retryAfter: Date | null;
  lastError: string | null;
}

export interface IMessage extends Document {
  conversationId: string;
  senderId: string;
  recipientId: string;
  text: string;
  readAt: Date | null;
  idempotencyKey?: string | null;
  publication: IMessagePublication;
  createdAt: Date;
}

const messagePublicationSchema = new Schema<IMessagePublication>(
  {
    eventId: { type: String, required: true },
    publishedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    retryAfter: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { _id: false }
);

const messageSchema = new Schema<IMessage>(
  {
    conversationId: { type: String, required: true, index: true },
    senderId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true, index: true },
    text: { type: String, required: true, maxlength: 5000 },
    readAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: undefined },
    publication: { type: messagePublicationSchema, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "messages",
  }
);

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index(
  { senderId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);
messageSchema.index({
  "publication.publishedAt": 1,
  "publication.retryAfter": 1,
});
messageSchema.index({ recipientId: 1, readAt: 1 });

export const MessageModel: Model<IMessage> =
  mongoose.models.Message || mongoose.model<IMessage>("Message", messageSchema);
