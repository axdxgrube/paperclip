import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import { recordApiLatencySample, resetApiLatencySamplesForTests } from "../services/api-latency.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

describe("GET /health", () => {
  beforeEach(() => {
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    resetApiLatencySamplesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with status ok", async () => {
    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = express();
    app.use("/health", healthRoutes(db));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable",
    });
  });

  it("reports tracked latency summary at /health/latency", async () => {
    recordApiLatencySample({
      method: "GET",
      path: "/api/health",
      statusCode: 200,
      durationMs: 42,
    });

    const app = express();
    app.use("/api/health", healthRoutes());

    const latencyRes = await request(app).get("/api/health/latency");
    expect(latencyRes.status).toBe(200);
    const healthRoute = latencyRes.body.routes.find((route: { key: string }) => route.key === "health");
    expect(healthRoute).toBeTruthy();
    expect(healthRoute.sampleCount).toBe(1);
    expect(healthRoute.method).toBe("GET");
    expect(healthRoute.pathTemplate).toBe("/api/health");
    expect(healthRoute.latencyMs.p50).toBe(42);
  });
});
