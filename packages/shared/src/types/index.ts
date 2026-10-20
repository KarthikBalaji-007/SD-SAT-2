import { EventType } from "../events/index.js";

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
  requestId?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

export type ServiceStatus = "up" | "down";

export interface DependencyHealth {
  status: ServiceStatus;
  latencyMs?: number;
  message?: string;
}

export type HealthStatus = "healthy" | "unhealthy" | "degraded";

export interface HealthCheckResponse {
  status: HealthStatus;
  timestamp: string;
  uptime?: number;
  services?: {
    postgres?: DependencyHealth;
    mongodb?: DependencyHealth;
    redis?: DependencyHealth;
    rabbitmq?: DependencyHealth;
    [key: string]: DependencyHealth | undefined;
  };
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface PaginationMeta {
  page?: number;
  limit?: number;
  nextCursor?: string;
  hasMore?: boolean;
  total?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: EventType | string;
  occurredAt: string;
  actorId?: string;
  aggregateId: string;
  schemaVersion: number;
  payload: T;
}

export type UserRole = "USER" | "MODERATOR" | "ADMIN";
export type PrivacySetting = "PUBLIC" | "PRIVATE";

export interface AuthUserResponse {
  id: string;
  username: string;
  displayName: string;
  email: string;
  bio?: string | null;
  avatarKey?: string | null;
  privacy: PrivacySetting;
  role: UserRole;
  createdAt: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  displayName: string;
  bio?: string;
  avatarKey?: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: AuthUserResponse;
}

export interface JwtPayload {
  sub: string;
  jti: string;
  role: UserRole;
  username: string;
  iat?: number;
  exp?: number;
}

export interface UserProfileResponse {
  id: string;
  username: string;
  displayName: string;
  bio?: string | null;
  avatarKey?: string | null;
  privacy: PrivacySetting;
  role: UserRole;
  createdAt: string;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isSelf?: boolean;
}

export interface UpdateProfileRequest {
  displayName?: string;
  bio?: string | null;
  avatarKey?: string | null;
  privacy?: PrivacySetting;
}

export interface FollowUserResponse {
  id: string;
  followerId: string;
  followedId: string;
  createdAt: string;
}

export interface FollowListItem {
  id: string;
  username: string;
  displayName: string;
  avatarKey?: string | null;
  followedAt: string;
}

export type ContentVisibility = "PUBLIC" | "FOLLOWERS_ONLY";
export type ContentStatus = "ACTIVE" | "HIDDEN" | "DELETED";

export interface AuthorSummary {
  id: string;
  username: string;
  displayName: string;
  avatarKey?: string | null;
}

export interface PostResponse {
  id: string;
  authorId: string;
  author: AuthorSummary;
  text: string;
  visibility: ContentVisibility;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  isAuthor?: boolean;
}

export interface CreatePostRequest {
  text: string;
  visibility?: ContentVisibility;
}

export interface UpdatePostRequest {
  text?: string;
  visibility?: ContentVisibility;
}

export interface CursorPaginationMeta {
  limit: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface CursorPaginatedResponse<T> {
  data: T[];
  meta: CursorPaginationMeta;
}

export type ReactionType = "LIKE" | "LOVE" | "CELEBRATE" | "INSIGHTFUL";
export type ReportTargetType = "POST" | "COMMENT" | "USER";
export type ReportStatus = "PENDING" | "RESOLVED" | "DISMISSED";

export interface CommentResponse {
  id: string;
  postId: string;
  authorId: string;
  author: AuthorSummary;
  text: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  isAuthor?: boolean;
}

export interface CreateCommentRequest {
  text: string;
}

export interface ReactionResponse {
  id: string;
  postId: string;
  userId: string;
  type: ReactionType;
  createdAt: string;
}

export interface CreateReactionRequest {
  type?: ReactionType;
}

export interface ReportResponse {
  id: string;
  reporterId: string;
  reporter?: AuthorSummary;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  status: ReportStatus;
  moderatorId?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface CreateReportRequest {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
}

export interface ResolveReportRequest {
  status: "RESOLVED" | "DISMISSED";
  action?: string;
  notes?: string;
}

export type NotificationType = "FOLLOW" | "POST" | "COMMENT" | "REACTION" | "MODERATION" | "MESSAGE";
export type NotificationEntityType = "USER" | "POST" | "COMMENT" | "REPORT" | "CONVERSATION";

export interface NotificationResponse {
  id: string;
  eventId: string;
  recipientId: string;
  actorId: string;
  actor?: AuthorSummary;
  type: NotificationType | string;
  entityType: NotificationEntityType | string;
  entityId: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsListMeta {
  page: number;
  limit: number;
  total: number;
  unreadCount: number;
  hasMore: boolean;
}

export interface NotificationsListResponse {
  data: NotificationResponse[];
  meta: NotificationsListMeta;
}

export interface ParticipantSummary {
  id: string;
  username: string;
  displayName: string;
  avatarKey?: string | null;
}

export interface ConversationResponse {
  id: string;
  participantIds: string[];
  participants?: ParticipantSummary[];
  lastMessage?: {
    text: string;
    senderId: string;
    createdAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageResponse {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  sender?: ParticipantSummary;
  text: string;
  readAt: string | null;
  createdAt: string;
}

export interface CreateConversationRequest {
  recipientId: string;
}

export interface SendMessageRequest {
  text: string;
  idempotencyKey?: string;
}

export interface SocketMessageNewEvent {
  message: MessageResponse;
}

export interface SocketMessageReadEvent {
  messageId: string;
  conversationId: string;
  readAt: string;
}



