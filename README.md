# ConnectSphere

A scalable, production-grade social networking and real-time messaging platform built with a polyglot persistence architecture, asynchronous event-driven streaming via RabbitMQ, in-memory caching with Redis, and real-time WebSocket communication via Socket.IO.

---

## 1. Project Overview & Implemented Features

ConnectSphere is organized as a TypeScript monorepo with strict domain separation, strong type safety, and resilient distributed systems patterns.

### Key Features

- **Authentication & Session Security:**
  - Secure registration and login using email or username with `bcryptjs` password hashing.
  - Stateless JWT access tokens with unique `jti` identifiers.
  - Fail-closed token revocation blacklist maintained in Redis for instantaneous logout.
  - Sliding-window rate limiting on sensitive routes using Redis counters.
  - Strict input validation via shared Zod schemas and security headers via Helmet.

- **User Profiles & Social Graph:**
  - Public and private profile visibility models.
  - Follow and unfollow workflows with self-follow prevention enforced at application and database constraint levels.
  - Follower and following lists with mutual-follow status indicators.

- **Posts & Personalized Timeline Feeds:**
  - Post authoring (up to 5,000 characters), retrieval, and soft deletion (`ACTIVE`, `REPORTED`, `HIDDEN`).
  - Personalized timeline feed merging authored posts and active posts from followed accounts.
  - Cursor-based feed pagination for stable scrolling.
  - Redis feed caching with an $O(1)$ version-increment invalidation strategy, avoiding expensive key scans.

- **Comments & Multi-Reactions:**
  - Threaded comment hierarchy (top-level comments and 1-level nested replies).
  - Multi-reaction engine supporting 5 reaction types (`LIKE`, `CELEBRATE`, `SUPPORT`, `INSIGHTFUL`, `FUNNY`).
  - Atomic reaction toggling and real-time aggregation counters.

- **Content Moderation & Reporting:**
  - Content reporting workflow with standardized violation categories (`SPAM`, `HARASSMENT`, `HATE_SPEECH`, `INAPPROPRIATE`, `OTHER`).
  - Role-based moderation endpoints for administrative review.
  - Actionable resolutions (`DISMISS`, `WARN_USER`, `HIDE_CONTENT`) with automated post hiding and audit logging.

- **Asynchronous Event-Driven Architecture:**
  - **Transactional Outbox Pattern:** PostgreSQL mutations transactionally insert `OutboxEvent` records.
  - **Outbox Relay Dispatcher:** Background poller uses `FOR UPDATE SKIP LOCKED` and lease windows to reliably publish events to RabbitMQ with publisher confirms.
  - **RabbitMQ Topology:** Durable topic exchange (`social.events`), dedicated consumer queues (`notifications.queue`, `feed-cache.queue`, `moderation-events.queue`), and dead-letter exchange/queue (`social.dlx` / `social.dlq`) with bounded exponential backoff.
  - **Notifications:** MongoDB-backed notification documents for social and direct messaging events with compound unique indexing `(eventId, recipientId)` to guarantee idempotent consumption.

- **Direct Messaging & Real-Time Socket.IO:**
  - One-to-one private conversations with canonical participant keys (`[userA, userB].sort().join(":")`) and unique indexes preventing duplicate conversations.
  - Direct message exchange with cursor pagination and client idempotency key deduplication.
  - **Standalone MongoDB Atomic Outbox:** Message documents embed outbox publication state (`publication.publishedAt`, `publication.retryAfter`) for atomic persistence without replica-set transactions.
  - **Socket.IO Real-Time Transport:** JWT handshake authentication reusing token validation logic, server-controlled private rooms (`user:<userId>`) and authorized conversation rooms (`conversation:<conversationId>`), and horizontal scale-out using `@socket.io/redis-adapter`.
  - Real-time read receipts (`PATCH /api/v1/messages/:id/read`) emitting live `message:read` events.

---

## 2. Technology Stack & Architecture

### System Architecture

```text
React Web Client (Vite + Tailwind)
   │  ▲
   │  │ HTTPS / REST + Socket.IO (port 5173 -> 4000)
   ▼  │
Node.js Express API (Port 4000)
   ├── Auth, Users, Follows, Posts, Comments, Reactions
   ├── Moderation & Reports
   ├── Direct Messaging & Socket.IO Gateway
   └── Transactional Outbox Table
        │
   ┌────┼───────────────────────────┬───────────────────────────┐
   ▼    ▼                           ▼                           ▼
PostgreSQL (5432)            MongoDB (27017)             Redis (6379)                MinIO (9000/9001)
- Relational Core            - Conversations             - Cache & Rate Limiting     - Media Storage (S3)
- Users, Follows             - Messages                  - Token Revocation
- Posts, Comments            - Notifications             - Socket.IO Pub/Sub
- Outbox Records
        │
        └── (Outbox Dispatcher in Worker)
                   │
                   ▼
       RabbitMQ Exchange: social.events (5672)
                   │
       ┌───────────┴───────────────────────┐
       ▼                                   ▼
  Queue: notifications.queue          Queue: feed-cache.queue
       │                                   │
  Background Worker (Node.js)         Background Worker (Node.js)
  - Persist notifications in Mongo    - Invalidate Redis feed versions
  - Deduplicate via compound index    - Handle moderation triggers
```

### Storage Responsibilities

| Store | Technology | Data Owned | Purpose |
|---|---|---|---|
| **Relational Store** | PostgreSQL 16 (Prisma ORM) | `User`, `Follow`, `Post`, `Comment`, `Reaction`, `Report`, `OutboxEvent` | Strict ACID consistency, relational constraints, foreign keys, and transactional outbox. |
| **Document Store** | MongoDB 7.0 (Mongoose) | `Conversation`, `Message`, `Notification` | High-write document persistence, flexible metadata, chronological chat indexing. |
| **In-Memory Cache** | Redis 7 | Feed page cache, profile cache, token revocation blacklist, rate limiters | Low-latency caching, $O(1)$ dynamic cache invalidation, and Socket.IO cross-node adapter. |
| **Message Broker** | RabbitMQ 3.13 | Topic exchange `social.events`, dead-letter queues | Decoupled event streaming between API mutations and background consumers. |
| **Object Storage** | MinIO (S3-compatible) | Binary media files, avatars | S3-compatible binary asset storage with presigned URLs. |

---

## 3. Monorepo Structure

```text
.
├── apps/
│   ├── api/          # Express REST API & Socket.IO real-time server
│   ├── worker/       # RabbitMQ consumers & Outbox/Message dispatchers
│   └── web/          # React 18 frontend (Vite + Tailwind CSS)
├── packages/
│   └── shared/       # Shared contracts, TypeScript interfaces, and Zod validation schemas
├── infrastructure/   # Docker configurations and init scripts
├── tests/            # End-to-end integration test suites (Vitest + Supertest)
├── docker-compose.yml
├── package.json
└── tsconfig.base.json
```

---

## 4. Prerequisites

Ensure the following tools are installed on your system:

- **Node.js:** `>= 20.x` (Tested on Node.js `22.x`)
- **npm:** `>= 10.x`
- **Docker & Docker Compose:** Docker Engine `24+` / Docker Desktop
- **Git:** `>= 2.x`

---

## 5. Local Setup & Configuration

### 1. Clone the Repository
```bash
git clone <repository-url>
cd ConnectSphere
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy the development environment template:
```bash
# On Linux/macOS
cp .env.example .env

# On Windows PowerShell
Copy-Item .env.example .env
```

The default values in `.env.example` are preconfigured to work with the local `docker-compose.yml` services:

| Variable | Default Value | Description |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment (`development`, `test`, `production`) |
| `API_PORT` / `PORT` | `4000` | Port for Express API and Socket.IO server |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed origin for CORS and WebSocket handshake |
| `VITE_API_URL` | `http://localhost:4000` | API endpoint for the web client |
| `DATABASE_URL` | `postgresql://connectsphere_user:connectsphere_dev_password@localhost:5432/connectsphere_db?schema=public` | PostgreSQL connection string |
| `MONGODB_URI` | `mongodb://root:mongo_dev_password@localhost:27017/connectsphere_chat?authSource=admin` | MongoDB connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ connection URL |
| `JWT_SECRET` | *(development secret)* | Secret key for signing and verifying JWTs (>= 32 chars) |

---

## 6. Running the Application

### Step 1: Start Infrastructure Containers
Launch PostgreSQL, MongoDB, Redis, RabbitMQ, and MinIO in the background:
```bash
docker compose up -d
```
Verify all containers are healthy:
```bash
docker compose ps
```

### Step 2: Apply Database Migrations & Generate Prisma Client
```bash
npm run prisma:generate --workspace=@connectsphere/api
npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma
```

### Step 3: Build Shared Contracts
```bash
npm run build:shared
```

### Step 4: Start Applications

You can start each service in separate terminal windows:

```bash
# 1. Start the API Server (Express + Socket.IO on http://localhost:4000)
npm run dev:api

# 2. Start the Background Worker (RabbitMQ consumers + Outbox dispatcher)
npm run dev:worker

# 3. Start the Web Frontend (Vite dev server on http://localhost:5173)
npm run dev:web
```

---

## 7. Testing & Build Commands

All test and build scripts are executed from the monorepo root:

| Command | Description |
|---|---|
| `npm run typecheck` | Runs `tsc --noEmit` across all workspaces (`shared`, `api`, `worker`, `web`). |
| `npm run build` | Compiles all packages and builds the production web distribution. |
| `npm test` | Runs the full Vitest automated test suite across all domains. |

### Test Suites Overview

The automated test suite verifies 155 test cases across 8 integration suites:

- `tests/foundation.test.ts` — Liveness/readiness probes, CORS headers, JSON formatting.
- `tests/auth.test.ts` — Registration, authentication, JWT verification, revocation, and rate limiting.
- `tests/users_and_follows.test.ts` — Profile management, privacy enforcement, and social graph.
- `tests/posts_and_feed.test.ts` — Post authoring, cursor pagination, timeline feed generation.
- `tests/comments_and_reactions.test.ts` — Threaded comments and reaction toggles.
- `tests/moderation.test.ts` — Content reporting, admin review, and automated content hiding.
- `tests/outbox_and_events.test.ts` — Outbox dispatcher leasing, RabbitMQ pub/sub, MongoDB notifications, and Redis feed cache invalidation.
- `tests/messages_and_socket.test.ts` — Direct messaging, idempotency, read receipts, Socket.IO handshake auth, room access, and real-time event delivery.

To run a specific test suite:
```bash
npx vitest run tests/messages_and_socket.test.ts
```

---

## 8. API & Real-Time Reference

### Health Endpoints (Unprefixed)
- `GET /health/live` — Verifies the Node.js API process is responsive.
- `GET /health/ready` — Probes live connectivity to PostgreSQL, MongoDB, Redis, and RabbitMQ.

### REST Endpoints (`/api/v1`)

| Domain | Method | Endpoint | Description |
|---|---|---|---|
| **Auth** | `POST` | `/api/v1/auth/register` | Register new user account |
| | `POST` | `/api/v1/auth/login` | Authenticate and obtain JWT token |
| | `POST` | `/api/v1/auth/logout` | Revoke active access token in Redis |
| | `GET` | `/api/v1/auth/me` | Retrieve authenticated user profile |
| **Users** | `GET` | `/api/v1/users/:username` | Fetch user profile by username |
| | `PATCH` | `/api/v1/users/me` | Update bio, display name, or privacy settings |
| | `POST` | `/api/v1/users/:id/follow` | Follow a user |
| | `DELETE` | `/api/v1/users/:id/follow` | Unfollow a user |
| | `GET` | `/api/v1/users/:id/followers` | List followers with pagination |
| | `GET` | `/api/v1/users/:id/following` | List following users with pagination |
| **Posts & Feed** | `POST` | `/api/v1/posts` | Create new post |
| | `GET` | `/api/v1/posts/:id` | Retrieve single post by ID |
| | `DELETE` | `/api/v1/posts/:id` | Soft-delete owned post |
| | `GET` | `/api/v1/feed` | Retrieve personalized timeline feed (cursor-paginated) |
| **Comments** | `POST` | `/api/v1/posts/:id/comments` | Add top-level comment to a post |
| | `GET` | `/api/v1/posts/:id/comments` | List top-level comments for a post |
| | `POST` | `/api/v1/comments/:id/replies` | Add nested reply to a comment |
| | `GET` | `/api/v1/comments/:id/replies` | List nested replies for a comment |
| | `DELETE` | `/api/v1/comments/:id` | Delete owned comment |
| **Reactions** | `POST` | `/api/v1/posts/:id/reactions` | Toggle reaction on a post (`LIKE`, `CELEBRATE`, etc.) |
| | `GET` | `/api/v1/posts/:id/reactions/mine` | Get caller's active reaction on a post |
| **Moderation** | `POST` | `/api/v1/reports` | Report post or comment for violation |
| | `GET` | `/api/v1/moderation/reports` | List submitted reports (Admin/Moderator only) |
| | `PATCH` | `/api/v1/moderation/reports/:id` | Resolve report (`DISMISS`, `WARN_USER`, `HIDE_CONTENT`) |
| **Notifications** | `GET` | `/api/v1/notifications` | List user notifications with actor profiles |
| | `PATCH` | `/api/v1/notifications/:id/read` | Mark notification as read |
| **Direct Messaging**| `POST` | `/api/v1/conversations` | Find or create 1-on-1 conversation |
| | `GET` | `/api/v1/conversations` | List user's active conversations |
| | `GET` | `/api/v1/conversations/:id/messages` | List conversation messages (cursor-paginated) |
| | `POST` | `/api/v1/conversations/:id/messages` | Send message (supports `idempotencyKey`) |
| | `PATCH` | `/api/v1/messages/:id/read` | Mark message as read by recipient |

For comprehensive payload schemas and status codes, see [API.md](API.md).

### Real-Time Socket.IO Protocol

The Socket.IO server runs on port `4000` and shares authentication state with the REST API.

#### Client Connection & Handshake
```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:4000", {
  auth: { token: "<your_jwt_access_token>" },
  transports: ["websocket"],
});
```

#### Client-to-Server Events
- `join:conversation` — `{ conversationId: string }`: Join a conversation room (membership verified on server).
- `leave:conversation` — `{ conversationId: string }`: Leave a conversation room.

#### Server-to-Client Events
- `message:new` — Emitted to the conversation room and the recipient's private user room when a message is sent.
- `message:read` — Emitted to the sender's private room when the recipient reads a message.
- `conversation:updated` — Emitted to participants when conversation activity occurs.
- `error` — Emitted when unauthorized actions are attempted.

---

## 9. Infrastructure Management & Web UIs

When the Docker containers are running, the following services and management consoles are accessible:

| Service | Host Port | Web Console / Interface | Default Credentials |
|---|---|---|---|
| **Web Frontend** | `5173` | `http://localhost:5173` | N/A |
| **API Server** | `4000` | `http://localhost:4000/api/v1` | N/A |
| **RabbitMQ Management** | `15672` | `http://localhost:15672` | `guest` / `guest` |
| **MinIO Web Console** | `9001` | `http://localhost:9001` | `minioadmin` / `minioadmin` |
| **PostgreSQL** | `5432` | `localhost:5432` | `connectsphere_user` / `connectsphere_dev_password` |
| **MongoDB** | `27017` | `localhost:27017` | `root` / `mongo_dev_password` |
| **Redis** | `6379` | `localhost:6379` | No password (local dev) |
