import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  queueHealthWatchdogService,
  QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND,
} from "../services/queue-health-watchdog.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queue-health watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queueHealthWatchdogService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queue-health-watchdog-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const ctoId = randomUUID();
    const ceoId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "SAM",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ctoId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ceoId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, ctoId, ceoId };
  }

  it("seeds one CTO draft issue when the company and CTO queues are idle", async () => {
    const { companyId, ctoId, ceoId } = await seedCompany();
    const issueSvc = issueService(db);
    const parent = await issueSvc.create(companyId, {
      title: "Own technical execution lane",
      status: "done",
      priority: "medium",
      assigneeAgentId: ceoId,
    });
    const completed = await issueSvc.create(companyId, {
      parentId: parent.id,
      title: "Harden assignment auth boundaries",
      status: "done",
      priority: "high",
      assigneeAgentId: ctoId,
    });

    const wakeups: Array<{ agentId: string; issueId: string | null }> = [];
    const svc = queueHealthWatchdogService(db, {
      heartbeat: {
        wakeup: async (agentId, opts) => {
          wakeups.push({
            agentId,
            issueId: typeof opts.payload?.issueId === "string" ? opts.payload.issueId : null,
          });
          return { ok: true };
        },
      },
    });

    const now = new Date("2026-04-06T16:30:00.000Z");
    const result = await svc.tickIdleQueues(now);

    expect(result.seeded).toBe(1);
    expect(result.skippedNotIdle).toBe(0);
    expect(result.skippedCooldown).toBe(0);

    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND),
          eq(issues.originId, `${companyId}:${ctoId}`),
        ),
      );

    expect(watchdogIssues).toHaveLength(1);
    const watchdogIssue = watchdogIssues[0]!;
    expect(watchdogIssue.assigneeAgentId).toBe(ctoId);
    expect(watchdogIssue.status).toBe("todo");
    expect(watchdogIssue.identifier).toBeTruthy();
    expect(watchdogIssue.description ?? "").toContain(
      `[${completed.identifier}](/SAM/issues/${completed.identifier})`,
    );

    const parentComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    expect(parentComments).toHaveLength(1);
    expect(parentComments[0]?.body ?? "").toContain(
      `[${watchdogIssue.identifier}](/SAM/issues/${watchdogIssue.identifier})`,
    );

    expect(wakeups).toEqual([{ agentId: ctoId, issueId: watchdogIssue.id }]);
  });

  it("does not seed when the queue is not idle", async () => {
    const { companyId, ctoId } = await seedCompany();
    const issueSvc = issueService(db);
    await issueSvc.create(companyId, {
      title: "Existing open CTO task",
      status: "todo",
      priority: "high",
      assigneeAgentId: ctoId,
      originKind: QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND,
      originId: `${companyId}:${ctoId}`,
    });

    const wakeups: Array<{ agentId: string; issueId: string | null }> = [];
    const svc = queueHealthWatchdogService(db, {
      heartbeat: {
        wakeup: async (agentId, opts) => {
          wakeups.push({
            agentId,
            issueId: typeof opts.payload?.issueId === "string" ? opts.payload.issueId : null,
          });
          return { ok: true };
        },
      },
    });

    const result = await svc.tickIdleQueues(new Date("2026-04-06T16:31:00.000Z"));
    expect(result.seeded).toBe(0);
    expect(result.skippedNotIdle).toBe(1);
    expect(wakeups).toEqual([]);
  });

  it("respects cooldown after a recently closed watchdog issue", async () => {
    const { companyId, ctoId } = await seedCompany();
    const issueSvc = issueService(db);
    const closedWatchdog = await issueSvc.create(companyId, {
      title: "Previous watchdog draft",
      status: "done",
      priority: "high",
      assigneeAgentId: ctoId,
      originKind: QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND,
      originId: `${companyId}:${ctoId}`,
    });
    await db
      .update(issues)
      .set({ updatedAt: new Date("2026-04-06T16:10:00.000Z") })
      .where(eq(issues.id, closedWatchdog.id));

    const svc = queueHealthWatchdogService(db, {
      heartbeat: {
        wakeup: async () => ({ ok: true }),
      },
    });

    const result = await svc.tickIdleQueues(new Date("2026-04-06T16:30:00.000Z"));
    expect(result.seeded).toBe(0);
    expect(result.skippedCooldown).toBe(1);
  });
});
