export const EventTypes = {
  POST_CREATED: "post.created",
  POST_UPDATED: "post.updated",
  POST_DELETED: "post.deleted",
  COMMENT_CREATED: "comment.created",
  COMMENT_DELETED: "comment.deleted",
  REACTION_CREATED: "reaction.created",
  REACTION_DELETED: "reaction.deleted",
  FOLLOW_CREATED: "follow.created",
  FOLLOW_DELETED: "follow.deleted",
  MESSAGE_SENT: "message.sent",
  MESSAGE_READ: "message.read",
  CONTENT_REPORTED: "content.reported",
  CONTENT_MODERATED: "content.moderated",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export const RABBITMQ_EXCHANGE = "social.events";
export const RABBITMQ_DLX = "social.dlx";
export const RABBITMQ_DLQ = "social.dlq";

export const RABBITMQ_QUEUES = {
  NOTIFICATIONS: "notifications.queue",
  FEED_CACHE: "feed-cache.queue",
  MODERATION_EVENTS: "moderation-events.queue",
} as const;
