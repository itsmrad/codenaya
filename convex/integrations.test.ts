// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ALICE = "user_alice";
afterEach(() => vi.unstubAllEnvs());

describe("reconnect credentials in place", () => {
  test.each(["needs_reauth", "revoked", "error"] as const)("resets %s and preserves links and scopes", async (status) => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
    const { alice, id } = await setup();
    const link = await alice.run(async (ctx) => {
      const approval = (await ctx.db.get(id))!;
      const link = (await ctx.db.get(approval.projectConnectionId))!;
      await ctx.db.patch(link.userConnectionId, {
        status, statusMessage: "Expired", scopes: ["read"],
        refreshLeaseId: "old-refresh", refreshLeaseExpiresAt: Date.now() + 60_000,
      });
      await ctx.db.patch(link._id, { providerScope: { projectRef: "scoped-project" }, allowedTools: ["list_tables"] });
      return (await ctx.db.get(link._id))!;
    });
    const args = {
      internalKey: "test-key", userId: ALICE, connectionId: link.userConnectionId,
      providerId: "github", authMode: "api_key" as const, maskedPreview: "new-key",
      serverUrl: "https://example.com/mcp-v2", scopes: [],
      kekProvider: "local", kekKeyId: "k", wrappedDek: "new-dek", ciphertext: "new-ciphertext", iv: "i", authTag: "a",
    };
    await expect(alice.mutation(api.system.updateUserConnectionCredential, { ...args, userId: "user_bob" }))
      .rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(alice.mutation(api.system.updateUserConnectionCredential, { ...args, providerId: "neon" }))
      .rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await alice.mutation(api.system.updateUserConnectionCredential, args);
    const connection = await alice.run((ctx) => ctx.db.get(link.userConnectionId));
    expect(connection).toMatchObject({
      status: "active", credentialRef: "ref", serverUrl: "https://example.com/mcp-v2", scopes: [], ciphertext: "new-ciphertext",
    });
    expect(connection?.statusMessage).toBeUndefined();
    expect(connection?.refreshLeaseId).toBeUndefined();
    expect(await alice.run((ctx) => ctx.db.get(link._id))).toEqual(link);
  });
});

/** A pending approval of Alice's, with `overrides` applied. */
async function setup(overrides: Partial<Doc<"mcpApprovals">> = {}) {
  const t = convexTest(schema, modules);
  const id = await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", { name: "App", ownerId: ALICE, updatedAt: now });
    const userConnectionId = await ctx.db.insert("userConnections", {
      userId: ALICE,
      providerId: "github",
      label: "GitHub",
      authMode: "api_key",
      serverUrl: "https://example.com/mcp",
      status: "active",
      credentialRef: "ref",
      kekProvider: "local",
      kekKeyId: "k",
      wrappedDek: "d",
      ciphertext: "c",
      iv: "i",
      authTag: "a",
      maskedPreview: "****",
      scopes: [],
      createdAt: now,
      updatedAt: now,
    });
    const projectConnectionId = await ctx.db.insert("projectConnections", {
      projectId,
      userConnectionId,
      ownerId: ALICE,
      enabled: true,
      readOnly: false,
      providerScope: {},
      writeApproved: true,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("mcpApprovals", {
      projectId,
      ownerId: ALICE,
      projectConnectionId,
      providerId: "github",
      toolName: "create_issue",
      argsPreview: "{}",
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    });
  });
  return {
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: "user_bob" }),
    id,
  };
}

// The client picks its toast from `data`, which production keeps when it
// redacts the message (#354).
describe("integrations.resolveApproval", () => {
  test("an already answered approval throws CONFLICT", async () => {
    const { alice, id } = await setup({ status: "approved" });

    await expect(
      alice.mutation(api.integrations.resolveApproval, { id, decision: "denied" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", status: "approved" } });
  });

  // Returned, not thrown: a throw rolled back the expiry write (#212).
  test("an approval past its deadline returns expired and stays expired", async () => {
    const { alice, id } = await setup({ expiresAt: Date.now() - 1 });

    await expect(
      alice.mutation(api.integrations.resolveApproval, { id, decision: "approved" }),
    ).resolves.toBe("expired");
    expect(await alice.run((ctx) => ctx.db.get("mcpApprovals", id))).toMatchObject({
      status: "expired",
    });
  });

  test("another user's approval throws FORBIDDEN", async () => {
    const { bob, id } = await setup();

    await expect(
      bob.mutation(api.integrations.resolveApproval, { id, decision: "approved" }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

describe("integrations.listPendingApprovals", () => {
  // Reads no clock (#53): a lapsed row stays listed until the cron marks it.
  test("lists pending rows, oldest first, to the project owner only", async () => {
    const { alice, bob, id } = await setup();
    const approval = (await alice.run((ctx) => ctx.db.get("mcpApprovals", id)))!;
    const row = {
      projectId: approval.projectId,
      ownerId: ALICE,
      projectConnectionId: approval.projectConnectionId,
      providerId: "github",
      toolName: "delete_repo",
      argsPreview: "{}",
      createdAt: approval.createdAt - 1,
      expiresAt: 0,
    };
    const lapsedId = await alice.run((ctx) =>
      ctx.db.insert("mcpApprovals", { ...row, status: "pending" }),
    );
    await alice.run((ctx) => ctx.db.insert("mcpApprovals", { ...row, status: "denied" }));

    const listed = await alice.query(api.integrations.listPendingApprovals, {
      projectId: approval.projectId,
    });
    expect(listed.map((row) => row._id)).toEqual([lapsedId, id]);
    await expect(
      bob.query(api.integrations.listPendingApprovals, { projectId: approval.projectId }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

// The duplicate check reads at most MAX_PROJECT_CONNECTIONS links, so a full
// project refuses new ones rather than risk a duplicate (#212).
test("linkConnectionToProject refuses a project at the link cap", async () => {
  const { alice, id } = await setup();
  const { projectId, projectConnectionId } = (await alice.run((ctx) => ctx.db.get("mcpApprovals", id)))!;
  const userConnectionId = await alice.run(async (ctx) => {
    const link = (await ctx.db.get("projectConnections", projectConnectionId))!;
    const row = {
      projectId,
      userConnectionId: link.userConnectionId,
      ownerId: ALICE,
      enabled: true,
      readOnly: true,
      providerScope: {},
      writeApproved: false,
      createdAt: 0,
      updatedAt: 0,
    };
    for (let i = 1; i < 100; i++) {
      await ctx.db.insert("projectConnections", row);
    }
    return link.userConnectionId;
  });

  await expect(
    alice.mutation(api.integrations.linkConnectionToProject, { projectId, userConnectionId }),
  ).rejects.toMatchObject({ data: { code: "LIMIT_EXCEEDED" } });
});


test("reconnect metadata is owner-checked and never exposes sealed credentials", async () => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  const { alice, id } = await setup();
  const connectionId = await alice.run(async (ctx) => {
    const approval = (await ctx.db.get(id))!;
    return (await ctx.db.get(approval.projectConnectionId))!.userConnectionId;
  });
  const args = { internalKey: "test-key", userId: ALICE, connectionId, providerId: "github", authMode: "api_key" as const };
  expect(await alice.query(api.system.getConnectionForReconnect, args)).toEqual({
    _id: connectionId, credentialRef: "ref", serverUrl: "https://example.com/mcp",
  });
  expect(await alice.query(api.system.getConnectionForReconnect, { ...args, userId: "user_bob" })).toBeNull();
  expect(await alice.query(api.system.getConnectionForReconnect, { ...args, connectionId: "malformed" })).toBeNull();
  await expect(alice.query(api.system.getConnectionForReconnect, { ...args, internalKey: "wrong" }))
    .rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("linked projects show names and scopes only to the connection owner", async () => {
  const { alice, bob, id } = await setup();
  const link = await alice.run(async (ctx) => {
    const approval = (await ctx.db.get(id))!;
    return (await ctx.db.get(approval.projectConnectionId))!;
  });
  expect(await alice.query(api.integrations.listConnectionProjects, { connectionId: link.userConnectionId })).toEqual([
    { projectId: link.projectId, name: "App", readOnly: false, enabled: true, providerScope: {} },
  ]);
  await expect(bob.query(api.integrations.listConnectionProjects, { connectionId: link.userConnectionId }))
    .rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await alice.run((ctx) => ctx.db.patch(link.projectId, { ownerId: "user_bob" }));
  expect(await alice.query(api.integrations.listConnectionProjects, { connectionId: link.userConnectionId })).toEqual([]);
});

test("ok/error tool calls record last-used, throttled to once per minute and scoped to the project", async () => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  vi.useFakeTimers();
  try {
    const { alice, id } = await setup();
    const approval = (await alice.run((ctx) => ctx.db.get(id)))!;
    const link = (await alice.run((ctx) => ctx.db.get(approval.projectConnectionId)))!;
    const record = (status: "ok" | "error" | "denied" | "blocked", projectId = link.projectId) =>
      alice.mutation(api.system.recordMcpToolCall, {
        internalKey: "test-key", projectId, projectConnectionId: link._id, providerId: "github",
        toolName: "list_repos", status, argsDigest: "d", durationMs: 1,
      });
    const usedAt = async () => (await alice.run((ctx) => ctx.db.get(link.userConnectionId)))?.lastUsedAt;

    await record("denied");
    await record("blocked");
    expect(await usedAt()).toBeUndefined();

    await record("ok");
    const first = await usedAt();
    expect(first).toBe(Date.now());
    vi.advanceTimersByTime(30_000);
    await record("error");
    expect(await usedAt()).toBe(first);
    vi.advanceTimersByTime(30_000);
    await record("error");
    const last = await usedAt();
    expect(last).toBe(Date.now());

    vi.advanceTimersByTime(60_000);
    const foreignProject = await alice.run((ctx) =>
      ctx.db.insert("projects", { name: "Bob", ownerId: "user_bob", updatedAt: Date.now() }));
    await record("ok", foreignProject);
    expect(await usedAt()).toBe(last);
    await alice.run((ctx) => ctx.db.patch(link.userConnectionId, { userId: "user_bob" }));
    await record("ok");
    expect(await usedAt()).toBe(last);
  } finally {
    vi.useRealTimers();
  }
});
