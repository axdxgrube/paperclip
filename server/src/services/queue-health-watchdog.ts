import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const ELIGIBLE_CTO_STATUSES = ["active", "running", "idle", "error"] as const;
const WATCHDOG_COOLDOWN_MS = 60 * 60 * 1000;
const WATCHDOG_SYSTEM_ACTOR_ID = "queue-health-watchdog";

export const QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND = "queue_health_watchdog";

type WatchdogCandidate = {
  companyId: string;
  ctoAgentId: string;
  ctoAgentName: string;
};

type WatchdogSkipReason =
  | "not_idle"
  | "cooldown";

type WatchdogEvaluationResult =
  | { outcome: "seeded"; issueId: string }
  | { outcome: "skipped"; reason: WatchdogSkipReason };

export interface QueueHealthWatchdogTickResult {
  candidates: number;
  seeded: number;
  skippedNotIdle: number;
  skippedCooldown: number;
  inFlightSkipped: boolean;
}

function issueLinkFromIdentifier(identifier: string | null | undefined) {
  const normalized = identifier?.trim();
  if (!normalized) return null;
  const dashIndex = normalized.indexOf("-");
  if (dashIndex <= 0) return null;
  const prefix = normalized.slice(0, dashIndex);
  return `/${prefix}/issues/${normalized}`;
}

function issueMarkdownLink(identifier: string | null | undefined) {
  const link = issueLinkFromIdentifier(identifier);
  if (!link || !identifier) return null;
  return `[${identifier}](${link})`;
}

function buildWatchdogOriginId(companyId: string, ctoAgentId: string) {
  return `${companyId}:${ctoAgentId}`;
}

function buildWatchdogTitle(lastCompletedIssueTitle: string | null | undefined) {
  const trimmed = lastCompletedIssueTitle?.trim();
  if (!trimmed) {
    return "Queue Health Draft: Next CTO Technical Priority";
  }
  const maxLength = 96;
  const clipped = trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
  return `Queue Health Draft: Follow-up to ${clipped}`;
}

function buildWatchdogDescription(input: {
  originId: string;
  ctoAgentName: string;
  companyOpenCount: number;
  ctoOpenCount: number;
  latestCompletedIssueLink: string | null;
}) {
  const lines = [
    "## Queue-Health Watchdog Draft",
    "",
    "Paperclip created this draft task automatically because the technical queue is currently idle.",
    "",
    `- Idle signal: company open issues (\`${OPEN_ISSUE_STATUSES.join("`, `")}\`) = ${input.companyOpenCount}.`,
    `- CTO open issues (\`${OPEN_ISSUE_STATUSES.join("`, `")}\`) = ${input.ctoOpenCount}.`,
    `- Watchdog key: \`${input.originId}\`.`,
    `- Target assignee: ${input.ctoAgentName}.`,
  ];

  if (input.latestCompletedIssueLink) {
    lines.push(`- Latest completed CTO issue: ${input.latestCompletedIssueLink}.`);
  } else {
    lines.push("- Latest completed CTO issue: none found.");
  }

  lines.push(
    "",
    "## Recommended Next Technical Task",
    "",
    "- Define one concrete implementation issue with acceptance criteria and verification steps.",
    "- If a follow-up risk exists, create and assign that issue immediately so the CTO queue is no longer idle.",
    "- If no technical follow-up is warranted, post rationale in this issue and request a new priority from leadership.",
  );

  return lines.join("\n");
}

function buildParentUpdateComment(input: {
  seededIssueLink: string;
  latestCompletedIssueLink: string | null;
}) {
  const lines = [
    "## Queue-Health Watchdog",
    "",
    "Auto-seeded a CTO draft task after idle queue detection.",
    "",
    `- Seeded task: ${input.seededIssueLink}`,
    `- Idle signal: company and CTO open queues (\`${OPEN_ISSUE_STATUSES.join("`, `")}\`) were both 0.`,
  ];
  if (input.latestCompletedIssueLink) {
    lines.push(`- Follow-up reference: ${input.latestCompletedIssueLink}`);
  }
  return lines.join("\n");
}

export function queueHealthWatchdogService(
  db: Db,
  deps: { heartbeat?: IssueAssignmentWakeupDeps } = {},
) {
  const issueSvc = issueService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);

  let tickInFlight = false;

  async function listWatchdogCandidates(): Promise<WatchdogCandidate[]> {
    return db
      .select({
        companyId: agents.companyId,
        ctoAgentId: agents.id,
        ctoAgentName: agents.name,
      })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          inArray(agents.status, ELIGIBLE_CTO_STATUSES as unknown as string[]),
          sql`lower(${agents.role}) = 'cto'`,
        ),
      );
  }

  async function countOpenIssuesForCompany(companyId: string) {
    const row = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Number(row?.count ?? 0);
  }

  async function countOpenIssuesForAgent(companyId: string, agentId: string) {
    const row = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          eq(issues.assigneeAgentId, agentId),
          inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Number(row?.count ?? 0);
  }

  async function evaluateCandidate(candidate: WatchdogCandidate, now: Date): Promise<WatchdogEvaluationResult> {
    const originId = buildWatchdogOriginId(candidate.companyId, candidate.ctoAgentId);

    const [companyOpenCount, ctoOpenCount] = await Promise.all([
      countOpenIssuesForCompany(candidate.companyId),
      countOpenIssuesForAgent(candidate.companyId, candidate.ctoAgentId),
    ]);

    if (companyOpenCount > 0 || ctoOpenCount > 0) {
      return { outcome: "skipped", reason: "not_idle" };
    }

    const [latestWatchdogIssue, latestCompletedCtoIssue] = await Promise.all([
      db
        .select({
          id: issues.id,
          status: issues.status,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, candidate.companyId),
            eq(issues.originKind, QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND),
            eq(issues.originId, originId),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          parentId: issues.parentId,
          projectId: issues.projectId,
          goalId: issues.goalId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, candidate.companyId),
            eq(issues.assigneeAgentId, candidate.ctoAgentId),
            eq(issues.status, "done"),
            ne(issues.originKind, QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(desc(issues.completedAt), desc(issues.updatedAt), desc(issues.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    if (
      latestWatchdogIssue &&
      !OPEN_ISSUE_STATUSES.includes(latestWatchdogIssue.status as (typeof OPEN_ISSUE_STATUSES)[number]) &&
      now.getTime() - latestWatchdogIssue.updatedAt.getTime() < WATCHDOG_COOLDOWN_MS
    ) {
      return { outcome: "skipped", reason: "cooldown" };
    }

    const latestCompletedIssueLink = issueMarkdownLink(latestCompletedCtoIssue?.identifier ?? null);
    const description = buildWatchdogDescription({
      originId,
      ctoAgentName: candidate.ctoAgentName,
      companyOpenCount,
      ctoOpenCount,
      latestCompletedIssueLink,
    });
    const issue = await issueSvc.create(candidate.companyId, {
      projectId: latestCompletedCtoIssue?.projectId ?? null,
      goalId: latestCompletedCtoIssue?.goalId ?? null,
      parentId: latestCompletedCtoIssue?.parentId ?? null,
      title: buildWatchdogTitle(latestCompletedCtoIssue?.title ?? null),
      description,
      status: "todo",
      priority: "high",
      assigneeAgentId: candidate.ctoAgentId,
      originKind: QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND,
      originId,
    });

    await logActivity(db, {
      companyId: candidate.companyId,
      actorType: "system",
      actorId: WATCHDOG_SYSTEM_ACTOR_ID,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        title: issue.title,
        originKind: QUEUE_HEALTH_WATCHDOG_ORIGIN_KIND,
      },
    });

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "queue_health_watchdog.tick",
      requestedByActorType: "system",
      requestedByActorId: WATCHDOG_SYSTEM_ACTOR_ID,
    });

    if (latestCompletedCtoIssue?.parentId) {
      const parentIssue = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(
          and(
            eq(issues.id, latestCompletedCtoIssue.parentId),
            eq(issues.companyId, candidate.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const seededIssueLink = issueMarkdownLink(issue.identifier);
      if (parentIssue && seededIssueLink) {
        const comment = await issueSvc.addComment(
          parentIssue.id,
          buildParentUpdateComment({
            seededIssueLink,
            latestCompletedIssueLink,
          }),
          {},
        );
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: WATCHDOG_SYSTEM_ACTOR_ID,
          action: "issue.commented",
          entityType: "issue",
          entityId: parentIssue.id,
          details: {
            commentId: comment.id,
            seededIssueId: issue.id,
            seededIdentifier: issue.identifier,
          },
        });
      } else if (parentIssue && !seededIssueLink) {
        logger.warn(
          { issueId: issue.id, identifier: issue.identifier },
          "queue-health watchdog could not build seeded issue link for parent update comment",
        );
      }
    }

    return { outcome: "seeded", issueId: issue.id };
  }

  return {
    tickIdleQueues: async (now: Date = new Date()): Promise<QueueHealthWatchdogTickResult> => {
      if (tickInFlight) {
        return {
          candidates: 0,
          seeded: 0,
          skippedNotIdle: 0,
          skippedCooldown: 0,
          inFlightSkipped: true,
        };
      }

      tickInFlight = true;
      try {
        const candidates = await listWatchdogCandidates();
        const result: QueueHealthWatchdogTickResult = {
          candidates: candidates.length,
          seeded: 0,
          skippedNotIdle: 0,
          skippedCooldown: 0,
          inFlightSkipped: false,
        };

        for (const candidate of candidates) {
          try {
            const outcome = await evaluateCandidate(candidate, now);
            if (outcome.outcome === "seeded") {
              result.seeded += 1;
              continue;
            }
            if (outcome.reason === "not_idle") result.skippedNotIdle += 1;
            if (outcome.reason === "cooldown") result.skippedCooldown += 1;
          } catch (err) {
            logger.error(
              {
                err,
                companyId: candidate.companyId,
                ctoAgentId: candidate.ctoAgentId,
              },
              "queue-health watchdog evaluation failed for CTO candidate",
            );
          }
        }

        return result;
      } finally {
        tickInFlight = false;
      }
    },
  };
}
