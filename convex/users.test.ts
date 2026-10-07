// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// A throwaway Svix secret; production uses the one from the Clerk dashboard.
const SECRET = `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}`;

const ALICE = "user_alice";
const BOB = "user_bob";

function signedRequest(event: unknown, secret = SECRET) {
  const body = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = new Date();
  return {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, timestamp, body),
    },
    body,
  };
}

function userEvent(
  type: "user.created" | "user.updated",
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type,
    object: "event",
    data: {
      id,
      first_name: "Alice",
      last_name: "Liddell",
      username: null,
      image_url: "https://img.clerk.com/alice.png",
      primary_email_address_id: "idn_1",
      email_addresses: [
        { id: "idn_0", email_address: "old@example.com" },
        { id: "idn_1", email_address: "alice@example.com" },
      ],
      updated_at: 1_000,
      ...overrides,
    },
  };
}

const deletedEvent = (id: string) => ({
  type: "user.deleted",
  object: "event",
  data: { id, deleted: true, object: "user" },
});

const setup = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof setup>;

const listUsers = (t: TestConvex) =>
  t.run((ctx) => ctx.db.query("users").collect());

/** Gives `ownerId` a project touching every project-scoped table. */
async function seedOwnedData(t: TestConvex, ownerId: string, files = 1) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: `${ownerId} project`,
      ownerId,
      updatedAt: now,
    });
    for (let i = 0; i < files; i++) {
      await ctx.db.insert("files", {
        projectId,
        name: `file-${i}.ts`,
        type: "file",
        content: "x",
        updatedAt: now,
      });
    }
    const storageId = await ctx.storage.store(new Blob(["binary"]));
    await ctx.db.insert("files", {
      projectId,
      name: "logo.png",
      type: "file",
      storageId,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      conversationId,
      projectId,
      role: "user",
      content: "hi",
    });
    const sealed = {
      kekProvider: "local",
      kekKeyId: "k1",
      wrappedDek: "dek",
      ciphertext: "ct",
      iv: "iv",
      authTag: "tag",
    };
    const userConnectionId = await ctx.db.insert("userConnections", {
      userId: ownerId,
      providerId: "supabase",
      label: "Supabase",
      authMode: "api_key",
      serverUrl: "https://mcp.example.com",
      status: "active",
      credentialRef: `ref-${ownerId}`,
      maskedPreview: "sbp_…1234",
      scopes: [],
      createdAt: now,
      updatedAt: now,
      ...sealed,
    });
    await ctx.db.insert("projectConnections", {
      projectId,
      userConnectionId,
      ownerId,
      enabled: true,
      readOnly: true,
      providerScope: {},
      writeApproved: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("projectEnvVars", {
      projectId,
      ownerId,
      key: "API_URL",
      visibility: "public",
      plainValue: "https://api.example.com",
      maskedPreview: "https://…",
      source: "manual",
      updatedAt: now,
    });
    await ctx.db.insert("oauthFlowStates", {
      state: `state-${ownerId}`,
      userId: ownerId,
      providerId: "supabase",
      serverUrl: "https://mcp.example.com",
      redirectUri: "https://app.example.com/callback",
      authServerUrl: "https://auth.example.com",
      createdAt: now,
      expiresAt: now + 60_000,
      ...sealed,
    });
    const showcaseId = await ctx.db.insert("showcaseProjects", {
      projectId,
      ownerId,
      ownerName: ownerId,
      title: "Demo",
      description: "Demo",
      techStack: [],
      designStyle: [],
      category: "web",
      upvotes: 1,
      downvotes: 0,
      viewCount: 1,
      importCount: 0,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("showcaseVotes", {
      showcaseProjectId: showcaseId,
      userId: ownerId,
      vote: "up",
      createdAt: now,
    });
    await ctx.db.insert("showcaseViews", {
      showcaseProjectId: showcaseId,
      userId: ownerId,
      viewedAt: now,
    });
    const aiProviderKeyId = await ctx.db.insert("aiProviderKeys", {
      userId: ownerId,
      provider: "openai",
      label: "OpenAI",
      secretRef: `secret-${ownerId}`,
      maskedPreview: "••••1234",
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...sealed,
    });
    await ctx.db.insert("userAiPreferences", {
      userId: ownerId,
      defaultKeyId: aiProviderKeyId,
      defaultModelId: "gpt-5.6-luna",
      updatedAt: now,
    });
    return { projectId, showcaseId, storageId };
  });
}

const OWNED_TABLES = [
  "projects",
  "files",
  "conversations",
  "messages",
  "userConnections",
  "projectConnections",
  "projectEnvVars",
  "oauthFlowStates",
  "showcaseProjects",
  "showcaseVotes",
  "showcaseViews",
  "aiProviderKeys",
  "userAiPreferences",
] as const;

const countRows = (t: TestConvex) =>
  t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of OWNED_TABLES) {
      counts[table] = (await ctx.db.query(table).collect()).length;
    }
    return counts;
  });

describe("POST /clerk-users-webhook", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("user.created upserts once even when the event is replayed", async () => {
    const t = setup();
    const request = signedRequest(userEvent("user.created", ALICE));

    expect((await t.fetch("/clerk-users-webhook", request)).status).toBe(200);
    expect((await t.fetch("/clerk-users-webhook", request)).status).toBe(200);

    const users = await listUsers(t);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      clerkUserId: ALICE,
      email: "alice@example.com",
      name: "Alice Liddell",
      imageUrl: "https://img.clerk.com/alice.png",
      updatedAt: 1_000,
    });
  });

  test("user.updated applies newer profiles and ignores stale ones", async () => {
    const t = setup();
    const { showcaseId } = await seedOwnedData(t, ALICE);
    await t.fetch("/clerk-users-webhook", signedRequest(userEvent("user.created", ALICE)));

    await t.fetch(
      "/clerk-users-webhook",
      signedRequest(
        userEvent("user.updated", ALICE, {
          first_name: "Al",
          last_name: null,
          image_url: "https://img.clerk.com/new.png",
          updated_at: 3_000,
        }),
      ),
    );
    // Delivered late: older than what is stored.
    await t.fetch(
      "/clerk-users-webhook",
      signedRequest(userEvent("user.updated", ALICE, { first_name: "Stale", updated_at: 2_000 })),
    );

    const users = await listUsers(t);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ name: "Al", updatedAt: 3_000 });

    // A field removed in Clerk is removed here too.
    await t.fetch(
      "/clerk-users-webhook",
      signedRequest(userEvent("user.updated", ALICE, {
          first_name: "Al",
          last_name: null,
          image_url: "",
          updated_at: 4_000,
        })),
    );
    expect((await listUsers(t))[0].imageUrl).toBeUndefined();

    const showcase = await t.run((ctx) => ctx.db.get(showcaseId));
    expect(showcase?.ownerName).toBe("Al");
    expect(showcase?.ownerAvatarUrl).toBeUndefined();
  });

  test("rejects a bad signature with 400 and writes nothing", async () => {
    const t = setup();
    const otherSecret = `whsec_${btoa("a-different-secret-entirely!")}`;

    const forged = await t.fetch(
      "/clerk-users-webhook",
      signedRequest(userEvent("user.created", ALICE), otherSecret),
    );
    expect(forged.status).toBe(400);

    const unsigned = await t.fetch("/clerk-users-webhook", {
      method: "POST",
      body: JSON.stringify(userEvent("user.created", ALICE)),
    });
    expect(unsigned.status).toBe(400);

    const tampered = signedRequest(userEvent("user.created", ALICE));
    tampered.body = tampered.body.replace("alice@example.com", "eve@example.com");
    expect((await t.fetch("/clerk-users-webhook", tampered)).status).toBe(400);

    expect(await listUsers(t)).toHaveLength(0);
  });

  test("returns 500 without writing when the secret is not configured", async () => {
    const t = setup();
    const request = signedRequest(userEvent("user.created", ALICE));
    vi.stubEnv("CLERK_WEBHOOK_SECRET", "");

    expect((await t.fetch("/clerk-users-webhook", request)).status).toBe(500);
    expect(await listUsers(t)).toHaveLength(0);
  });

  test("acknowledges unrelated events without writing", async () => {
    const t = setup();
    const response = await t.fetch(
      "/clerk-users-webhook",
      signedRequest({ type: "session.created", object: "event", data: { id: "sess_1" } }),
    );

    expect(response.status).toBe(200);
    expect(await listUsers(t)).toHaveLength(0);
  });

  test("user.deleted purges every owned row in batches and leaves other users alone", async () => {
    vi.useFakeTimers();
    const t = setup();
    // More files than one batch so the purge has to reschedule itself.
    const alice = await seedOwnedData(t, ALICE, 250);
    const bob = await seedOwnedData(t, BOB);
    await t.fetch("/clerk-users-webhook", signedRequest(userEvent("user.created", ALICE)));

    // Alice voted on Bob's entry; the purge takes that vote back out.
    await t.run(async (ctx) => {
      await ctx.db.insert("showcaseVotes", {
        showcaseProjectId: bob.showcaseId,
        userId: ALICE,
        vote: "up",
        createdAt: Date.now(),
      });
      await ctx.db.patch(bob.showcaseId, { upvotes: 2 });
    });

    const response = await t.fetch("/clerk-users-webhook", signedRequest(deletedEvent(ALICE)));
    expect(response.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      for (const table of OWNED_TABLES) {
        const rows = (await ctx.db.query(table).collect()) as Array<{
          ownerId?: string;
          userId?: string;
          projectId?: Id<"projects">;
        }>;
        for (const row of rows) {
          expect(row.ownerId ?? row.userId ?? BOB).toBe(BOB);
          if (row.projectId) expect(row.projectId).not.toBe(alice.projectId);
        }
      }
      expect(await ctx.db.system.get(alice.storageId)).toBeNull();
      expect(await ctx.db.system.get(bob.storageId)).not.toBeNull();
      expect(await ctx.db.get(bob.showcaseId)).toMatchObject({ upvotes: 1 });
    });

    // Bob still has exactly his own seed: one of each, plus his 2 files.
    expect(await countRows(t)).toEqual({
      ...Object.fromEntries(OWNED_TABLES.map((table) => [table, 1])),
      files: 2,
    });

    // Alice is a tombstone without profile data, and a late update cannot revive her.
    await t.fetch(
      "/clerk-users-webhook",
      signedRequest(userEvent("user.updated", ALICE, { updated_at: 9_000 })),
    );
    const [tombstone] = await listUsers(t);
    expect(tombstone.clerkUserId).toBe(ALICE);
    expect(tombstone.deletedAt).toBeTypeOf("number");
    expect(tombstone.email).toBeUndefined();
    expect(tombstone.name).toBeUndefined();
  });

  test("user.deleted for a user with no row still purges their data", async () => {
    vi.useFakeTimers();
    const t = setup();
    await seedOwnedData(t, ALICE);

    await t.fetch("/clerk-users-webhook", signedRequest(deletedEvent(ALICE)));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const counts = await countRows(t);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
    expect(await listUsers(t)).toMatchObject([{ clerkUserId: ALICE }]);
  });
});

describe("users.current / users.ensureCurrent", () => {
  test("ensureCurrent creates the row from JWT claims once", async () => {
    const t = setup();
    const asAlice = t.withIdentity({
      subject: ALICE,
      name: "Alice",
      email: "alice@example.com",
    });

    expect(await asAlice.query(api.users.current, {})).toBeNull();
    await asAlice.mutation(api.users.ensureCurrent, {});
    await asAlice.mutation(api.users.ensureCurrent, {});

    expect(await listUsers(t)).toHaveLength(1);
    expect(await asAlice.query(api.users.current, {})).toMatchObject({
      clerkUserId: ALICE,
      name: "Alice",
      email: "alice@example.com",
    });
  });
});
