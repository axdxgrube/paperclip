import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByOrigin: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      runId: req.header("x-paperclip-run-id") ?? undefined,
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByOrigin.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue({
      ...makeIssue("todo"),
      id: "issue-created",
      title: "Created",
      parentId: "11111111-1111-4111-8111-111111111111",
    });
    mockIssueService.checkout.mockImplementation(async () => ({
      ...makeIssue("todo"),
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      checkoutRunId: null,
      executionRunId: null,
    }));
    mockIssueService.release.mockImplementation(async () => ({
      ...makeIssue("todo"),
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
    }));
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      adoptedFromRunId: null,
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
      replayed: false,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });

  it("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("returns idempotent replay for duplicate run-scoped issue comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        body: "hello",
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: null,
        authorUserId: "local-board",
        replayed: false,
      })
      .mockResolvedValueOnce({
        id: "comment-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        body: "hello",
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: null,
        authorUserId: "local-board",
        replayed: true,
      });

    const first = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .set("x-paperclip-run-id", "17ac5446-284d-421e-ad07-da166936762b")
      .send({ body: "hello" });

    expect(first.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.comment_added" }),
    );

    mockLogActivity.mockClear();
    mockHeartbeatService.wakeup.mockClear();
    mockIssueService.findMentionedAgents.mockClear();

    const second = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .set("x-paperclip-run-id", "17ac5446-284d-421e-ad07-da166936762b")
      .send({ body: "hello" });

    expect(second.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
  });

  it("replays create-subtask retries without writing duplicates", async () => {
    mockIssueService.getByOrigin.mockResolvedValue({
      id: "issue-existing",
      companyId: "company-1",
      title: "Created",
      parentId: "11111111-1111-4111-8111-111111111111",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/issues")
      .set("x-paperclip-run-id", "17ac5446-284d-421e-ad07-da166936762b")
      .send({
        parentId: "11111111-1111-4111-8111-111111111111",
        title: "Created",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("skips duplicate checkout side effects when retrying the same state", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      checkoutRunId: null,
      executionRunId: null,
    });
    mockIssueService.checkout.mockResolvedValue({
      ...makeIssue("todo"),
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      checkoutRunId: null,
      executionRunId: null,
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .send({
        agentId: "22222222-2222-4222-8222-222222222222",
        expectedStatuses: ["todo", "in_progress"],
      });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("skips duplicate release side effects when issue is already released", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("todo"),
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    mockIssueService.release.mockResolvedValue({
      ...makeIssue("todo"),
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/release")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
