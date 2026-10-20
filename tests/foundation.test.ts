import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  apiErrorResponseSchema,
  healthCheckResponseSchema,
  eventEnvelopeSchema,
  EventTypes,
} from "@connectsphere/shared";
import { app } from "../apps/api/src/server.js";

describe("Phase 1: Foundation Shared Contracts", () => {
  it("should validate a conforming API error response", () => {
    const sampleError = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid email",
        details: [{ field: "email", message: "Email is malformed" }],
        requestId: "req_test_123",
      },
    };

    const parsed = apiErrorResponseSchema.safeParse(sampleError);
    expect(parsed.success).toBe(true);
  });

  it("should reject an invalid API error response missing required fields", () => {
    const invalidError = {
      error: {
        code: "ERROR",
        // missing message
      },
    };

    const parsed = apiErrorResponseSchema.safeParse(invalidError);
    expect(parsed.success).toBe(false);
  });

  it("should validate a conforming Event Envelope", () => {
    const sampleEvent = {
      eventId: "123e4567-e89b-12d3-a456-426614174000",
      eventType: EventTypes.POST_CREATED,
      occurredAt: new Date().toISOString(),
      aggregateId: "post_789",
      schemaVersion: 1,
      payload: {
        authorId: "user_123",
        text: "Hello ConnectSphere",
      },
    };

    const parsed = eventEnvelopeSchema.safeParse(sampleEvent);
    expect(parsed.success).toBe(true);
  });

  it("should reject an invalid event envelope missing aggregateId or payload", () => {
    const invalidEvent = {
      eventId: "123",
      eventType: "post.created",
      occurredAt: "2026-10-13T00:00:00Z",
      schemaVersion: 1,
      // missing aggregateId and payload
    };

    const parsed = eventEnvelopeSchema.safeParse(invalidEvent);
    expect(parsed.success).toBe(false);
  });
});

describe("Phase 1: Backend API Liveness & Base Endpoints", () => {
  it("GET /health/live should return 200 with healthy status and uptime", async () => {
    const res = await request(app).get("/health/live");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.timestamp).toBeDefined();
    expect(typeof res.body.uptime).toBe("number");

    const schemaCheck = healthCheckResponseSchema.safeParse(res.body);
    expect(schemaCheck.success).toBe(true);
  });

  it("GET /api/v1 should return 200 with online info", async () => {
    const res = await request(app).get("/api/v1");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("ConnectSphere API");
    expect(res.body.status).toBe("online");
  });

  it("should attach x-request-id header to every response", async () => {
    const res = await request(app).get("/health/live");
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});
