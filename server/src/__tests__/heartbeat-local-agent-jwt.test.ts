import { afterEach, describe, expect, it } from "vitest";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { createHeartbeatLocalAgentAuthToken, ensureHeartbeatLocalAgentJwtSecret } from "../services/heartbeat.js";

describe("heartbeat local agent JWT fallback", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const originalSecret = process.env[secretEnv];

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalSecret;
  });

  it("returns null when local JWT is not supported", () => {
    process.env[secretEnv] = "configured-secret";
    const token = createHeartbeatLocalAgentAuthToken({
      supportsLocalAgentJwt: false,
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      runId: "run-1",
    });
    expect(token).toBeNull();
  });

  it("mints a run JWT when a secret is already configured", () => {
    process.env[secretEnv] = "configured-secret";
    const token = createHeartbeatLocalAgentAuthToken({
      supportsLocalAgentJwt: true,
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      runId: "run-1",
    });
    expect(typeof token).toBe("string");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.sub).toBe("agent-1");
    expect(claims?.company_id).toBe("company-1");
    expect(claims?.adapter_type).toBe("codex_local");
    expect(claims?.run_id).toBe("run-1");
  });

  it("generates an in-memory secret and mints a run JWT when missing", () => {
    delete process.env[secretEnv];
    const generated = ensureHeartbeatLocalAgentJwtSecret();
    expect(generated).toMatch(/^[a-f0-9]{64}$/);
    expect(process.env[secretEnv]).toBe(generated);

    const token = createHeartbeatLocalAgentAuthToken({
      supportsLocalAgentJwt: true,
      agentId: "agent-2",
      companyId: "company-2",
      adapterType: "codex_local",
      runId: "run-2",
    });
    expect(typeof token).toBe("string");
    const claims = verifyLocalAgentJwt(token!);
    expect(claims?.sub).toBe("agent-2");
    expect(claims?.company_id).toBe("company-2");
    expect(claims?.adapter_type).toBe("codex_local");
    expect(claims?.run_id).toBe("run-2");
  });
});
