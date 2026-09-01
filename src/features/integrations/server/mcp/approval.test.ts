import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_TIMEOUT_MS,
  buildArgsPreview,
  digestArgs,
  refusalMessage,
  requestApproval,
  type ApprovalRow,
  type ApprovalTransport,
} from "./approval";

/**
 * The gate must fail closed. A gate that fails open is worse than no gate: it
 * creates the appearance of review while permitting unreviewed mutations against
 * the user's real infrastructure.
 */

/**
 * Fake transport with a virtual clock, so timeout behaviour is tested without
 * waiting 15 real minutes.
 */
function makeTransport(
  options: {
    statuses?: ApprovalStatusScript;
    createThrows?: boolean;
    readThrows?: number;
    missingRow?: boolean;
  } = {},
) {
  let clock = 1_000_000;
  let reads = 0;
  const expired: string[] = [];
  const created: Array<Record<string, unknown>> = [];

  const transport: ApprovalTransport = {
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    async create(request) {
      if (options.createThrows) throw new Error("convex unavailable");
      created.push(request);
      return "approval_1";
    },
    async read() {
      reads += 1;
      if (options.readThrows && reads <= options.readThrows) {
        throw new Error("transient read failure");
      }
      if (options.missingRow) return null;
      const status = options.statuses?.(reads) ?? "pending";
      return { status, expiresAt: clock + APPROVAL_TIMEOUT_MS } as ApprovalRow;
    },
    async expire(id) {
      expired.push(id);
    },
  };

  return {
    transport,
    expired,
    created,
    readCount: () => reads,
    clock: () => clock,
  };
}

type ApprovalStatusScript = (readNumber: number) => ApprovalRow["status"];

const baseRequest = {
  providerId: "supabase",
  projectConnectionId: "link_1",
  displayName: "Supabase",
  toolName: "execute_sql",
  args: { query: "create table users (id serial)" },
};

describe("requestApproval", () => {
  it("approves once the user approves", async () => {
    const { transport } = makeTransport({
      statuses: (n) => (n >= 2 ? "approved" : "pending"),
    });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(true);
    expect(decision.approvalId).toBe("approval_1");
  });

  it("denies when the user declines", async () => {
    const { transport } = makeTransport({ statuses: () => "denied" });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/declined/);
  });

  it("denies when the row reports expired", async () => {
    const { transport } = makeTransport({ statuses: () => "expired" });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/expired/);
  });

  it("denies and marks expired when nobody answers", async () => {
    const { transport, expired } = makeTransport({ statuses: () => "pending" });

    const decision = await requestApproval({
      transport,
      ...baseRequest,
      timeoutMs: 10_000,
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/no answer within/);
    // Without this the UI keeps offering an Approve button for a run that has
    // already stopped waiting.
    expect(expired).toEqual(["approval_1"]);
  });

  it("denies when the request cannot be created", async () => {
    // If we cannot ask, we cannot proceed.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { transport } = makeTransport({ createThrows: true });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/could not be created/);
    expect(decision.approvalId).toBeUndefined();
  });

  it("denies when the row disappears mid-flight", async () => {
    // Deleted rather than answered. Assuming consent here would be the dangerous
    // reading.
    const { transport } = makeTransport({ missingRow: true });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/withdrawn/);
  });

  it("survives transient read failures and still honours a later approval", async () => {
    // A blip talking to Convex must not deny a call the user did approve.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport } = makeTransport({
      readThrows: 2,
      statuses: (n) => (n >= 3 ? "approved" : "pending"),
    });

    const decision = await requestApproval({ transport, ...baseRequest });

    expect(decision.approved).toBe(true);
  });

  it("does not deny early when reads keep failing, up to the deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transport, expired } = makeTransport({
      readThrows: 1_000,
    });

    const decision = await requestApproval({
      transport,
      ...baseRequest,
      timeoutMs: 10_000,
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/no answer within/);
    expect(expired).toEqual(["approval_1"]);
  });

  it("stores a redacted argument preview", async () => {
    const { transport, created } = makeTransport({ statuses: () => "approved" });

    await requestApproval({
      transport,
      ...baseRequest,
      args: { token: "sbp_supersecretvalue123456" },
      knownSecrets: ["sbp_supersecretvalue123456"],
    });

    // The row is read by the browser, so it must not become a second unencrypted
    // copy of a credential.
    expect(created[0].argsPreview).not.toContain("sbp_supersecretvalue123456");
    expect(String(created[0].argsPreview)).toContain("[redacted-by-codenaya]");
  });

  it("passes the deadline through so the UI can hide stale prompts", async () => {
    const { transport, created, clock } = makeTransport({
      statuses: () => "approved",
    });

    await requestApproval({ transport, ...baseRequest, timeoutMs: 60_000 });

    expect(created[0].expiresAt).toBe(clock() - 2_000 + 60_000);
  });
});

describe("buildArgsPreview", () => {
  it("pretty-prints for readability", () => {
    const preview = buildArgsPreview({ query: "select 1", limit: 10 });
    expect(preview).toContain('"query"');
    expect(preview).toContain("\n");
  });

  it("redacts known secrets and token shapes", () => {
    const preview = buildArgsPreview(
      { key: "my-service-role-key-value", other: "AKIAIOSFODNN7EXAMPLE" },
      ["my-service-role-key-value"],
    );

    expect(preview).not.toContain("my-service-role-key-value");
    expect(preview).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("truncates a very large payload", () => {
    const preview = buildArgsPreview({ sql: "x".repeat(10_000) });
    expect(preview.length).toBeLessThan(2_300);
    expect(preview).toMatch(/truncated/);
  });

  it("does not throw on circular arguments", () => {
    // Failing here would deny a legitimate call.
    const args: Record<string, unknown> = { a: 1 };
    args.self = args;

    expect(() => buildArgsPreview(args)).not.toThrow();
  });

  it("handles empty arguments", () => {
    expect(buildArgsPreview({})).toBe("{}");
  });
});

describe("digestArgs", () => {
  it("is deterministic", () => {
    const args = { query: "select 1" };
    expect(digestArgs(args)).toBe(digestArgs(args));
  });

  it("differs for different arguments", () => {
    expect(digestArgs({ q: "a" })).not.toBe(digestArgs({ q: "b" }));
  });

  it("never contains the argument values", () => {
    // The audit log records that a call happened, not what was in it.
    const digest = digestArgs({ secret: "AKIAIOSFODNN7EXAMPLE" });
    expect(digest).not.toContain("AKIA");
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not throw on circular arguments", () => {
    const args: Record<string, unknown> = {};
    args.self = args;
    expect(() => digestArgs(args)).not.toThrow();
  });
});

describe("refusalMessage", () => {
  it("tells the model not to retry", () => {
    // Without this, models routinely read a refusal as a transient error and
    // immediately call the tool again.
    const message = refusalMessage("Supabase", "execute_sql", "the user declined");

    expect(message).toMatch(/Do NOT retry/);
    expect(message).toContain("execute_sql");
    expect(message).toContain("Supabase");
    expect(message).toContain("the user declined");
  });

  it("directs the model to explain and ask", () => {
    const message = refusalMessage("Neon", "delete_branch", "it expired");
    expect(message).toMatch(/ask how/i);
  });
});
