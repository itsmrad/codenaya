import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({ convex: mocks }));

import { createConvexApprovalGate, createConvexAuditSink, type ConvexMcpContext } from "./convex-approval";
import type { ResolvedMcpServer } from "./resolve-servers";

const ctx = {
  internalKey: "key",
  projectId: "p1",
  messageId: "m1",
  knownSecrets: ["sk_live_123"],
} as unknown as ConvexMcpContext;

const server = {
  providerId: "supabase",
  projectConnectionId: "pc1",
  displayName: "Supabase",
} as ResolvedMcpServer;

// Steps run inline; a durable sleep moves the fake clock on, so polling costs no
// time and a gate that never settles still reaches its deadline.
const runner = {
  run: <T>(_id: string, fn: () => Promise<T>) => fn(),
  sleep: async (_id: string, ms: number) => void vi.setSystemTime(Date.now() + ms),
};

const ask = () =>
  createConvexApprovalGate(ctx)({
    server,
    toolName: "execute_sql",
    args: { query: "drop table users", key: "sk_live_123" },
    invocation: { invocationId: "inv1" } as never,
    runner,
  });

const calls = (name: string) =>
  mocks.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === name);

describe("createConvexApprovalGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: 0 });
    mocks.mutation.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:createMcpApproval" ? "approval_1" : true
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a redacted approval row and returns a single-use claim once approved", async () => {
    mocks.query
      .mockResolvedValueOnce({ status: "pending", expiresAt: Infinity })
      .mockResolvedValueOnce({ status: "approved", expiresAt: Infinity });

    const decision = await ask();

    const [[, row]] = calls("system:createMcpApproval");
    expect(row).toMatchObject({
      internalKey: "key",
      projectId: "p1",
      messageId: "m1",
      projectConnectionId: "pc1",
      toolName: "execute_sql",
      mcpInvocationId: "inv1",
    });
    expect(row.argsPreview).not.toContain("sk_live_123");
    const [[readRef, readArgs]] = mocks.query.mock.calls;
    expect(getFunctionName(readRef)).toBe("system:getMcpApproval");
    expect(readArgs).toEqual({ internalKey: "key", approvalId: "approval_1" });
    expect(decision).toMatchObject({ approved: true, approvalId: "approval_1" });

    await expect(decision.claim?.()).resolves.toBe(true);
    expect(calls("system:claimMcpApproval")[0][1]).toEqual({
      internalKey: "key",
      approvalId: "approval_1",
    });
  });

  it("refuses the call when the claim cannot be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.query.mockResolvedValue({ status: "approved", expiresAt: Infinity });
    const decision = await ask();
    mocks.mutation.mockRejectedValue(new Error("convex down"));

    await expect(decision.claim?.()).resolves.toBe(false);
  });

  it("returns a do-not-retry refusal when the user declines", async () => {
    mocks.query.mockResolvedValue({ status: "denied", expiresAt: Infinity });

    const decision = await ask();

    expect(decision).toMatchObject({ approved: false, approvalId: "approval_1" });
    expect(decision.reason).toContain('"execute_sql" on Supabase was not run because the user declined');
    expect(decision.reason).toContain("Do NOT retry");
    expect(decision.claim).toBeUndefined();
  });

  it("expires the row when nobody answers in time", async () => {
    mocks.query.mockResolvedValue({ status: "pending", expiresAt: 0 });

    const decision = await ask();

    expect(decision).toMatchObject({ approved: false });
    expect(decision.reason).toContain("no answer within 15 minutes");
    expect(calls("system:expireMcpApproval")[0][1]).toEqual({
      internalKey: "key",
      approvalId: "approval_1",
    });
  });
});

describe("createConvexAuditSink", () => {
  it("records a digest of the call, never the arguments", async () => {
    vi.clearAllMocks();

    await createConvexAuditSink(ctx)({
      providerId: "supabase",
      projectConnectionId: "pc1",
      toolName: "execute_sql",
      status: "ok",
      durationMs: 12,
      redactionCount: 1,
      matchedRules: ["stripe-key"],
      invocationId: "inv1",
      argsDigest: "abc123",
    });

    const [[ref, row]] = mocks.mutation.mock.calls;
    expect(getFunctionName(ref)).toBe("system:recordMcpToolCall");
    expect(row).toMatchObject({
      internalKey: "key",
      projectId: "p1",
      providerId: "supabase",
      toolName: "execute_sql",
      status: "ok",
      argsDigest: "abc123",
      durationMs: 12,
      mcpInvocationId: "inv1",
      // Lets the mutation record the connection's "last used" time.
      projectConnectionId: "pc1",
    });
    expect(row.redactionSummary).toMatch(/^[0-9a-f]{16}$/);
  });
});
