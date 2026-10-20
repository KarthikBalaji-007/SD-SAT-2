import { z } from "zod";

export const apiErrorDetailSchema = z.object({
  field: z.string().optional(),
  message: z.string(),
});

export const apiErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(apiErrorDetailSchema).optional(),
  requestId: z.string().optional(),
});

export const apiErrorResponseSchema = z.object({
  error: apiErrorBodySchema,
});

export const serviceStatusSchema = z.enum(["up", "down"]);

export const dependencyHealthSchema = z.object({
  status: serviceStatusSchema,
  latencyMs: z.number().optional(),
  message: z.string().optional(),
});

export const healthStatusSchema = z.enum(["healthy", "unhealthy", "degraded"]);

export const healthCheckResponseSchema = z.object({
  status: healthStatusSchema,
  timestamp: z.string(),
  uptime: z.number().optional(),
  services: z.record(dependencyHealthSchema).optional(),
});

export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});

export const eventEnvelopeSchema = z.object({
  eventId: z.string().uuid().or(z.string().min(1)),
  eventType: z.string().min(1),
  occurredAt: z.string().datetime().or(z.string().min(1)),
  actorId: z.string().optional(),
  aggregateId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  payload: z.record(z.unknown()),
});

export const userRoleSchema = z.enum(["USER", "MODERATOR", "ADMIN"]);
export const privacySettingSchema = z.enum(["PUBLIC", "PRIVATE"]);

export const registerRequestSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain alphanumeric characters and underscores")
    .toLowerCase(),
  email: z.string().trim().email("Invalid email format").toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().trim().min(1, "Display name is required").max(50),
  bio: z.string().trim().max(250).optional(),
  avatarKey: z.string().optional(),
});

export const loginRequestSchema = z.object({
  identifier: z.string().trim().min(1, "Email or username is required"),
  password: z.string().min(1, "Password is required"),
});

export const updateProfileRequestSchema = z
  .object({
    displayName: z.string().trim().min(1, "Display name cannot be empty").max(50, "Display name max 50 characters").optional(),
    bio: z.string().trim().max(250, "Bio cannot exceed 250 characters").nullable().optional(),
    avatarKey: z.string().trim().nullable().optional(),
    privacy: privacySettingSchema.optional(),
  })
  .strict("Unknown or immutable fields are not permitted in profile update")
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one field must be provided for update" }
  );

export const followPaginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const contentVisibilitySchema = z.enum(["PUBLIC", "FOLLOWERS_ONLY"]);
export const contentStatusSchema = z.enum(["ACTIVE", "HIDDEN", "DELETED"]);

export const createPostRequestSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Post content cannot be empty")
      .max(2000, "Post content cannot exceed 2000 characters"),
    visibility: contentVisibilitySchema.optional().default("PUBLIC"),
  })
  .strict("Unknown fields are not permitted in post creation");

export const updatePostRequestSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Post content cannot be empty")
      .max(2000, "Post content cannot exceed 2000 characters")
      .optional(),
    visibility: contentVisibilitySchema.optional(),
  })
  .strict("Unknown or immutable fields are not permitted in post update")
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one field must be provided for update" }
  );

export const feedPaginationParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const reactionTypeSchema = z.enum(["LIKE", "LOVE", "CELEBRATE", "INSIGHTFUL"]);
export const reportTargetTypeSchema = z.enum(["POST", "COMMENT", "USER"]);
export const reportStatusSchema = z.enum(["PENDING", "RESOLVED", "DISMISSED"]);

export const createCommentRequestSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Comment text cannot be empty")
      .max(1000, "Comment text cannot exceed 1000 characters"),
  })
  .strict("Unknown fields are not permitted in comment creation");

export const commentPaginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const createReactionRequestSchema = z
  .object({
    type: reactionTypeSchema.optional().default("LIKE"),
  })
  .strict("Unknown fields are not permitted in reaction creation");

export const createReportRequestSchema = z
  .object({
    targetType: reportTargetTypeSchema,
    targetId: z.string().uuid("Target ID must be a valid UUID"),
    reason: z
      .string()
      .trim()
      .min(3, "Reason must be at least 3 characters")
      .max(1000, "Reason cannot exceed 1000 characters"),
  })
  .strict("Unknown fields are not permitted in report filing");

export const resolveReportRequestSchema = z
  .object({
    status: z.enum(["RESOLVED", "DISMISSED"]),
    action: z.string().trim().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict("Unknown fields are not permitted in report resolution");

export const moderationReportsQuerySchema = z.object({
  status: z.enum(["PENDING", "RESOLVED", "DISMISSED", "ALL"]).optional().default("PENDING"),
  targetType: reportTargetTypeSchema.optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const notificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  unreadOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

export const createConversationRequestSchema = z
  .object({
    recipientId: z.string().uuid("Recipient ID must be a valid UUID"),
  })
  .strict("Unknown fields are not permitted in conversation creation");

export const sendMessageRequestSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "Message text cannot be empty")
      .max(5000, "Message cannot exceed 5000 characters"),
    idempotencyKey: z
      .string()
      .trim()
      .max(100, "Idempotency key cannot exceed 100 characters")
      .optional(),
  })
  .strict("Unknown fields are not permitted in message creation");

export const messagesPaginationParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const conversationsPaginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});





