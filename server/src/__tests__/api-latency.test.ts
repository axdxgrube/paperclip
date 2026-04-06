import { beforeEach, describe, expect, it } from "vitest";
import { getApiLatencySummary, recordApiLatencySample, resetApiLatencySamplesForTests } from "../services/api-latency.js";

describe("api latency service", () => {
  beforeEach(() => {
    resetApiLatencySamplesForTests();
  });

  it("records tracked route samples and computes percentiles", () => {
    const durations = [100, 120, 140, 160, 180];
    for (const duration of durations) {
      recordApiLatencySample({
        method: "GET",
        path: "/api/health",
        statusCode: 200,
        durationMs: duration,
      });
    }

    const summary = getApiLatencySummary();
    const healthRoute = summary.routes.find((route) => route.key === "health");
    expect(healthRoute).toBeTruthy();
    expect(healthRoute?.sampleCount).toBe(5);
    expect(healthRoute?.latencyMs?.p50).toBe(140);
    expect(healthRoute?.latencyMs?.p95).toBe(176);
    expect(healthRoute?.latencyMs?.p99).toBe(179.2);
    expect(healthRoute?.alert.status).toBe("insufficient_data");
  });

  it("raises critical alerts when latency breaches thresholds", () => {
    for (let index = 0; index < 25; index += 1) {
      recordApiLatencySample({
        method: "POST",
        path: "/api/issues/abc-123/checkout",
        statusCode: 200,
        durationMs: 800,
      });
    }

    const summary = getApiLatencySummary();
    const checkoutRoute = summary.routes.find((route) => route.key === "issues.checkout");
    expect(checkoutRoute?.sampleCount).toBe(25);
    expect(checkoutRoute?.latencyMs?.p95).toBe(800);
    expect(checkoutRoute?.alert.status).toBe("critical");
  });

  it("raises warning alerts for elevated server error rate", () => {
    for (let index = 0; index < 20; index += 1) {
      recordApiLatencySample({
        method: "GET",
        path: "/api/agents/me/inbox-lite",
        statusCode: index < 19 ? 200 : 500,
        durationMs: 120,
      });
    }

    const summary = getApiLatencySummary();
    const inboxRoute = summary.routes.find((route) => route.key === "agents.me.inbox_lite");
    expect(inboxRoute?.sampleCount).toBe(20);
    expect(inboxRoute?.errorRatePct).toBe(5);
    expect(inboxRoute?.alert.status).toBe("warning");
  });
});
