import mongoose, { Schema, Document, Model } from "mongoose";

export interface INotification extends Document {
  eventId: string;
  recipientId: string;
  actorId: string;
  type: string;
  entityType: string;
  entityId: string;
  message: string;
  readAt: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    eventId: { type: String, required: true },
    recipientId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    type: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    message: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "notifications",
  }
);

notificationSchema.index({ eventId: 1, recipientId: 1 }, { unique: true });
notificationSchema.index({ recipientId: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, readAt: 1 });

export const NotificationModel: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>("Notification", notificationSchema);
