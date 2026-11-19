// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: ALICE,
      updatedAt: 0,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: 0,
    });
    return { projectId, conversationId };
  });
  return { t, ...ids };
}

describe("system.getOwnedProject", () => {
  test("returns the project to its owner", async () => {
    const { t, projectId } = await setup();

    const project = await t.query(api.system.getOwnedProject, {
      internalKey: INTERNAL_KEY,
      projectId,
      userId: ALICE,
    });

    expect(project?._id).toBe(projectId);
  });

  test("returns null for another user, a missing id and a malformed id alike", async () => {
    const { t, projectId, conversationId } = await setup();
    const missingId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", { name: "Gone", ownerId: ALICE, updatedAt: 0 });
      await ctx.db.delete(id);
      return id;
    });

    for (const [id, userId] of [
      [projectId, BOB],
      [missingId, ALICE],
      ["not-an-id", ALICE],
      // An id from another table must not pass as a project id.
      [conversationId, ALICE],
    ]) {
      const project = await t.query(api.system.getOwnedProject, {
        internalKey: INTERNAL_KEY,
        projectId: id,
        userId,
      });
      expect(project).toBeNull();
    }
  });

  test("returns null for a project that is being deleted", async () => {
    const { t, projectId } = await setup();
    await t.run((ctx) => ctx.db.patch(projectId, { deletingAt: 1 }));

    const project = await t.query(api.system.getOwnedProject, {
      internalKey: INTERNAL_KEY,
      projectId,
      userId: ALICE,
    });

    expect(project).toBeNull();
  });

  test("rejects a wrong internal key", async () => {
    const { t, projectId } = await setup();

    await expect(
      t.query(api.system.getOwnedProject, { internalKey: "nope", projectId, userId: ALICE }),
    ).rejects.toThrow("Invalid internal key");
  });
});

describe("system.getOwnedConversation", () => {
  test("returns the conversation to its project's owner", async () => {
    const { t, conversationId } = await setup();

    const conversation = await t.query(api.system.getOwnedConversation, {
      internalKey: INTERNAL_KEY,
      conversationId,
      userId: ALICE,
    });

    expect(conversation?._id).toBe(conversationId);
  });

  test("returns null for another user and for a malformed id", async () => {
    const { t, conversationId } = await setup();

    for (const [id, userId] of [
      [conversationId, BOB],
      ["not-an-id", ALICE],
    ]) {
      const conversation = await t.query(api.system.getOwnedConversation, {
        internalKey: INTERNAL_KEY,
        conversationId: id,
        userId,
      });
      expect(conversation).toBeNull();
    }
  });
});

const sealed = {
  kekProvider: "local",
  kekKeyId: "k1",
  wrappedDek: "dek",
  ciphertext: "ct",
  iv: "iv",
  authTag: "tag",
};

/** Alice's project and a second project, connection and link that belong to Bob. */
async function setupTwoTenants() {
  const base = await setup();
  const bob = await base.t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "Bob's", ownerId: BOB, updatedAt: 0 });
    const conversationId = await ctx.db.insert("conversations", { projectId, title: "Chat", updatedAt: 0 });
    const connectionId = await ctx.db.insert("userConnections", {
      userId: BOB,
      providerId: "supabase",
      label: "Supabase",
      authMode: "oauth",
      serverUrl: "https://mcp.example.com",
      status: "active",
      credentialRef: "ref-bob",
      maskedPreview: "sbp_…1234",
      scopes: [],
      tokenExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
      ...sealed,
    });
    const linkId = await ctx.db.insert("projectConnections", {
      projectId,
      userConnectionId: connectionId,
      ownerId: BOB,
      enabled: true,
      readOnly: true,
      providerScope: {},
      writeApproved: false,
      createdAt: 0,
      updatedAt: 0,
    });
    return { projectId, conversationId, connectionId, linkId };
  });
  return { ...base, bob };
}

describe("internal-key writes verify ownership from the database (#239)", () => {
  test("createMessage refuses a conversation of another project", async () => {
    const { t, projectId, bob } = await setupTwoTenants();

    await expect(
      t.mutation(api.system.createMessage, {
        internalKey: INTERNAL_KEY,
        conversationId: bob.conversationId,
        projectId,
        role: "user",
        content: "hi",
      })
    ).rejects.toThrow("Conversation not found");
  });

  test("createMcpApproval attributes the row to the project owner and refuses another project's link", async () => {
    const { t, projectId, bob } = await setupTwoTenants();
    const approval = {
      internalKey: INTERNAL_KEY,
      providerId: "supabase",
      toolName: "apply_migration",
      argsPreview: "{}",
      expiresAt: Date.now() + 60_000,
    };

    await expect(
      t.mutation(api.system.createMcpApproval, {
        ...approval,
        projectId,
        projectConnectionId: bob.linkId,
      })
    ).rejects.toThrow("Project connection not found");

    const id = await t.mutation(api.system.createMcpApproval, {
      ...approval,
      projectId: bob.projectId,
      projectConnectionId: bob.linkId,
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.ownerId).toBe(BOB);
  });

  test("recordMcpToolCall attributes the row to the project owner", async () => {
    const { t, projectId } = await setupTwoTenants();

    await t.mutation(api.system.recordMcpToolCall, {
      internalKey: INTERNAL_KEY,
      projectId,
      providerId: "supabase",
      toolName: "list_tables",
      status: "ok",
      argsDigest: "d",
      durationMs: 1,
    });

    const rows = await t.run((ctx) => ctx.db.query("mcpToolAuditLog").collect());
    expect(rows.map((row) => row.ownerId)).toEqual([ALICE]);
  });

  test("user-connection writes refuse a connection the project owner doesn't hold", async () => {
    const { t, projectId, bob } = await setupTwoTenants();
    const scope = { internalKey: INTERNAL_KEY, projectId, connectionId: bob.connectionId };

    expect(
      await t.mutation(api.system.claimUserConnectionRefresh, {
        ...scope,
        leaseId: "lease",
        refreshSkewMs: 0,
        leaseDurationMs: 60_000,
      })
    ).toBe("missing");
    expect(
      await t.mutation(api.system.completeUserConnectionRefresh, {
        ...scope,
        leaseId: "lease",
        maskedPreview: "x",
        scopes: [],
        tokenExpiresAt: null,
        ...sealed,
      })
    ).toBe(false);
    expect(
      await t.mutation(api.system.failUserConnectionRefresh, {
        ...scope,
        leaseId: "lease",
        reauthRequired: true,
      })
    ).toBe(false);
    await expect(
      t.mutation(api.system.updateUserConnectionStatus, { ...scope, status: "revoked" })
    ).rejects.toThrow("Connection not found");

    const connection = await t.run((ctx) => ctx.db.get(bob.connectionId));
    expect(connection?.status).toBe("active");
    expect(connection?.refreshLeaseId).toBeUndefined();

    // Bob's own project may refresh it.
    expect(
      await t.mutation(api.system.claimUserConnectionRefresh, {
        ...scope,
        projectId: bob.projectId,
        leaseId: "lease",
        refreshSkewMs: 0,
        leaseDurationMs: 60_000,
      })
    ).toBe("acquired");
  });

  test("setSecretEnvVar refuses a source connection the project owner doesn't hold", async () => {
    const { t, projectId, bob } = await setupTwoTenants();

    await expect(
      t.mutation(api.system.setSecretEnvVar, {
        internalKey: INTERNAL_KEY,
        projectId,
        ownerId: ALICE,
        key: "SUPABASE_KEY",
        secretRef: "ref",
        maskedPreview: "x",
        source: "integration",
        sourceConnectionId: bob.connectionId,
        ...sealed,
      })
    ).rejects.toThrow("Connection not found");
  });

  test.each(["NEXT_PUBLIC_KEY", "VITE_KEY"])("public env writes reject secrets for %s (#684)", async (key) => {
    const { t, projectId } = await setup();
    const scope = { internalKey: INTERNAL_KEY, projectId, ownerId: ALICE, key };
    const value = ["sk", "_test_", "FAKE0123456789abcdef"].join("");
    const rejected = {
      data: {
        code: "INVALID_ARGUMENT",
        message: "This looks like a secret key and would be published in the browser bundle. Use a name without a public prefix and store it as a secret instead.",
      },
    };

    await expect(
      t.mutation(api.system.setPublicEnvVarInternal, { ...scope, value })
    ).rejects.toMatchObject(rejected);
    expect(await t.run((ctx) => ctx.db.query("projectEnvVars").collect())).toEqual([]);

    const publishable = ["pk", "_test_", "FAKE0123456789abcdef"].join("");
    const id = await t.mutation(api.system.setPublicEnvVarInternal, { ...scope, value: publishable });
    const before = await t.run((ctx) => ctx.db.get("projectEnvVars", id));
    expect(before).toMatchObject({ plainValue: publishable, maskedPreview: publishable });
    await expect(
      t.mutation(api.system.setPublicEnvVarInternal, { ...scope, value })
    ).rejects.toMatchObject(rejected);
    expect(await t.run((ctx) => ctx.db.get("projectEnvVars", id))).toEqual(before);

    await expect(
      t.mutation(api.system.setPublicEnvVarInternal, { ...scope, internalKey: "wrong-key", value })
    ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });

  test("env-var writes refuse an ownerId that isn't the project owner (#211)", async () => {
    const { t, projectId } = await setupTwoTenants();
    const scope = { internalKey: INTERNAL_KEY, projectId, key: "API_URL" };

    await expect(
      t.mutation(api.system.setSecretEnvVar, {
        ...scope,
        ownerId: BOB,
        secretRef: "ref",
        maskedPreview: "x",
        source: "manual",
        ...sealed,
      })
    ).rejects.toThrow("Project not found");
    await expect(
      t.mutation(api.system.setPublicEnvVarInternal, { ...scope, ownerId: BOB, value: "x" })
    ).rejects.toThrow("Project not found");
    expect(await t.run((ctx) => ctx.db.query("projectEnvVars").collect())).toEqual([]);

    await t.mutation(api.system.setPublicEnvVarInternal, { ...scope, ownerId: ALICE, value: "x" });
    const rows = await t.run((ctx) => ctx.db.query("projectEnvVars").collect());
    expect(rows.map((row) => row.ownerId)).toEqual([ALICE]);
  });
});
