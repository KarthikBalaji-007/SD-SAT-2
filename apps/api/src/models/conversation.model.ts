import mongoose, { Schema, Document, Model } from "mongoose";

export interface IConversation extends Document {
  participantIds: string[];
  participantPairKey: string;
  lastMessageText?: string | null;
  lastMessageSenderId?: string | null;
  lastMessageAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildParticipantPairKey(id1: string, id2: string): string {
  if (id1 === id2) {
    throw new Error("Self-conversation is not permitted");
  }
  return [id1, id2].sort().join(":");
}

const conversationSchema = new Schema<IConversation>(
  {
    participantIds: {
      type: [String],
      required: true,
      validate: {
        validator: function (v: string[]) {
          return Array.isArray(v) && v.length === 2 && v[0] !== v[1];
        },
        message: "A conversation must contain exactly two distinct participants.",
      },
    },
    participantPairKey: {
      type: String,
      required: true,
      unique: true,
    },
    lastMessageText: {
      type: String,
      default: null,
      maxlength: 5000,
    },
    lastMessageSenderId: {
      type: String,
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "conversations",
  }
);

// Index for chronological retrieval of user's conversations
conversationSchema.index({ participantIds: 1, updatedAt: -1 });

export const ConversationModel: Model<IConversation> =
  mongoose.models.Conversation ||
  mongoose.model<IConversation>("Conversation", conversationSchema);
