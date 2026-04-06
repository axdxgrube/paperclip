import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { assertCompanyAccess } from "../routes/authz.js";

const mockBoardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn(),
  resolveBoardAccess: vi.fn(),
  touchBoardApiKey: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => mockBoardAuth,
}));

type StubRows = {
  keyRow?: Record<string, unknown> | null;
  agentRow?: Record<string, unknown> | null;
};

function createDbStub(rows: StubRows) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockImplementation(() => {
          if (table === agentApiKeys) return Promise.resolve(rows.keyRow ? [rows.keyRow] : []);
          if (table === agents) return Promise.resolve(rows.agentRow ? [rows.agentRow] : []);
          return Promise.resolve([]);
        }),
      })),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createApp(rows: StubRows) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(createDbStub(rows) as any, { deploymentMode: "authenticated" }));
  app.get("/api/companies/:companyId/check", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.status(200).json({ actor: req.actor });
  });
  app.use(errorHandler);
  return app;
}

const baseKey = {
  id: "key-1",
  companyId: "company-a",
  agentId: "agent-1",
  keyHash: "hash",
  name: "runner",
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date("2026-04-06T00:00:00.000Z"),
  updatedAt: new Date("2026-04-06T00:00:00.000Z"),
} as const;

const baseAgent = {
  id: "agent-1",
  companyId: "company-a",
  status: "running",
} as const;

describe("agent auth company boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
    mockBoardAuth.resolveBoardAccess.mockResolvedValue(null);
    mockBoardAuth.touchBoardApiKey.mockResolvedValue(undefined);
  });

  it("allows agent keys to access routes scoped to their own company", async () => {
    const app = createApp({ keyRow: baseKey, agentRow: baseAgent });

    const res = await request(app)
      .get("/api/companies/company-a/check")
      .set("Authorization", "Bearer agent-token");

    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("agent");
    expect(res.body.actor.agentId).toBe("agent-1");
    expect(res.body.actor.companyId).toBe("company-a");
  });

  it("rejects agent keys on another company route", async () => {
    const app = createApp({ keyRow: baseKey, agentRow: baseAgent });

    const res = await request(app)
      .get("/api/companies/company-b/check")
      .set("Authorization", "Bearer agent-token");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Agent key cannot access another company");
  });

  it("treats mismatched key/agent company pairs as unauthenticated", async () => {
    const app = createApp({
      keyRow: { ...baseKey, companyId: "company-a" },
      agentRow: { ...baseAgent, companyId: "company-b" },
    });

    const res = await request(app)
      .get("/api/companies/company-a/check")
      .set("Authorization", "Bearer agent-token");

    expect(res.status).toBe(401);
  });
});
