import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat wakeup idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wakeup idempotency replay", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wakeup-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix };
  }

  async function seedAgent(input: { companyId: string; name: string; role?: string }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name,
      role: input.role ?? "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("replays an idempotent wakeup to the existing run without extra side effects", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = await seedAgent({ companyId, name: "CodexCoder" });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const idempotencyKey = "wake-replay-existing-run";
    const now = new Date("2026-04-06T19:30:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      idempotencyKey,
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId },
      startedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wakeup replay issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const replay = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      idempotencyKey,
    });

    expect(replay?.id).toBe(runId);

    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)));
    expect(wakeRows).toHaveLength(1);

    const runRows = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runRows).toHaveLength(1);
  });

  it("replays deferred issue-execution wakeups without incrementing coalesced state", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const assigneeAgentId = await seedAgent({ companyId, name: "PrimaryAgent" });
    const collaboratorAgentId = await seedAgent({ companyId, name: "CollaboratorAgent" });
    const issueId = randomUUID();
    const executionRunId = randomUUID();
    const idempotencyKey = "wake-replay-deferred";
    const now = new Date("2026-04-06T19:40:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: executionRunId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId },
      startedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred wakeup issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      checkoutRunId: executionRunId,
      executionRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: collaboratorAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          taskKey: issueId,
          wakeReason: "issue_comment_mentioned",
        },
      },
      status: "deferred_issue_execution",
      idempotencyKey,
      coalescedCount: 0,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const heartbeat = heartbeatService(db);
    const replay = await heartbeat.wakeup(collaboratorAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId },
      idempotencyKey,
    });

    expect(replay).toBeNull();

    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, collaboratorAgentId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      );
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0]?.status).toBe("deferred_issue_execution");
    expect(wakeRows[0]?.coalescedCount).toBe(0);
  });

  it("relinks runId on replay when the original wakeup row lost its run reference", async () => {
    const { companyId } = await seedCompany();
    const agentId = await seedAgent({ companyId, name: "RuntimeAgent" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const idempotencyKey = "wake-replay-relink-run-id";
    const now = new Date("2026-04-06T19:45:00.000Z");

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_retry",
      payload: { taskKey: "task-1" },
      status: "queued",
      idempotencyKey,
      runId: null,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { taskKey: "task-1" },
      createdAt: now,
      updatedAt: now,
    });

    const heartbeat = heartbeatService(db);
    const replay = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_retry",
      payload: { taskKey: "task-1" },
      contextSnapshot: { taskKey: "task-1" },
      idempotencyKey,
    });

    expect(replay?.id).toBe(runId);

    const wakeRow = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeRow?.runId).toBe(runId);

    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)));
    expect(wakeRows).toHaveLength(1);
  });
});
