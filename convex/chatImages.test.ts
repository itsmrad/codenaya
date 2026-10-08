// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { deleteProjectBatch } from "./projectCascade";
import schema from "./schema";
import { MAX_CHAT_IMAGE_BYTES } from "../src/features/conversations/chat-images";

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
  const { projectId, conversationId } = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      name: "Todo app",
      ownerId: ALICE,
      updatedAt: Date.now(),
    });
    const conversationId = await ctx.db.insert("conversations", {
      projectId,
      title: "Chat",
      updatedAt: Date.now(),
    });
    return { projectId, conversationId };
  });
  // convex-test leaves contentType unset; the real upload sets it from the
  // request's Content-Type, so it is filled in here.
  const upload = (contentType: string, bytes = 16) =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)]));
      await ctx.db.patch(storageId as unknown as Id<"chatImages">, { contentType } as never);
      return storageId;
    });
  return {
    t,
    alice: t.withIdentity({ subject: ALICE }),
    bob: t.withIdentity({ subject: BOB }),
    projectId,
    conversationId,
    upload,
  };
}

const sendUserMessage = (
  t: ReturnType<typeof convexTest>,
  args: {
    conversationId: Id<"conversations">;
    projectId: Id<"projects">;
    images?: Id<"_storage">[];
    ownerId?: string;
  },
) =>
  t.mutation(api.system.createMessage, {
    internalKey: INTERNAL_KEY,
    role: "user",
    content: "Match this screenshot",
    ...args,
  });

describe("chatImages.register", () => {
  test("claims an allowed image for the project owner", async () => {
    const { t, alice, projectId, upload } = await setup();
    const storageId = await upload("image/png");

    expect(await alice.mutation(api.chatImages.register, { projectId, storageId })).toBeNull();

    const rows = await t.run((ctx) => ctx.db.query("chatImages").collect());
    expect(rows).toMatchObject([{ storageId, projectId, ownerId: ALICE }]);
  });

  test("deletes and refuses a file that is not an allowed image", async () => {
    const { t, alice, projectId, upload } = await setup();
    const svg = await upload("image/svg+xml");
    const huge = await upload("image/png", MAX_CHAT_IMAGE_BYTES + 1);

    for (const storageId of [svg, huge]) {
      expect(await alice.mutation(api.chatImages.register, { projectId, storageId })).toMatch(
        /PNG, JPEG, WebP or GIF/,
      );
      expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
    }
    expect(await t.run((ctx) => ctx.db.query("chatImages").collect())).toEqual([]);
  });

  test("refuses someone else's project and an already claimed image", async () => {
    const { alice, bob, projectId, upload } = await setup();
    const storageId = await upload("image/png");

    await expect(
      bob.mutation(api.chatImages.generateUploadUrl, { projectId }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      bob.mutation(api.chatImages.register, { projectId, storageId }),
    ).rejects.toThrow(/Unauthorized/);

    await alice.mutation(api.chatImages.register, { projectId, storageId });
    await expect(
      alice.mutation(api.chatImages.register, { projectId, storageId }),
    ).rejects.toThrow(/already registered/);
  });
});

describe("messages with images", () => {
  test("a message attaches its sender's images and lists them with URLs", async () => {
    const { t, alice, projectId, conversationId, upload } = await setup();
    const storageId = await upload("image/jpeg");
    await alice.mutation(api.chatImages.register, { projectId, storageId });

    await sendUserMessage(t, { conversationId, projectId, images: [storageId], ownerId: ALICE });

    const [message] = await alice.query(api.conversations.getMessages, { conversationId });
    expect(message.images).toEqual([storageId]);
    expect(message.imageUrls).toHaveLength(1);
    expect(message.imageUrls?.[0]).toMatch(/^https?:\/\//);

    const recent = await t.query(api.system.getRecentMessages, {
      internalKey: INTERNAL_KEY,
      conversationId,
    });
    expect(recent[0].imageUrls).toEqual(message.imageUrls);
  });

  test("text-only messages are stored and listed as before", async () => {
    const { t, alice, projectId, conversationId } = await setup();
    await sendUserMessage(t, { conversationId, projectId });

    const [message] = await alice.query(api.conversations.getMessages, { conversationId });
    expect(message).not.toHaveProperty("images");
    expect(message).not.toHaveProperty("imageUrls");
  });

  test("refuses unregistered, foreign or too many images", async () => {
    const { t, alice, projectId, conversationId, upload } = await setup();
    const unregistered = await upload("image/png");
    const registered = await upload("image/png");
    await alice.mutation(api.chatImages.register, { projectId, storageId: registered });

    await expect(
      sendUserMessage(t, { conversationId, projectId, images: [unregistered], ownerId: ALICE }),
    ).rejects.toThrow(/Image not found/);
    await expect(
      sendUserMessage(t, { conversationId, projectId, images: [registered], ownerId: BOB }),
    ).rejects.toThrow(/Image not found/);
    await expect(
      sendUserMessage(t, { conversationId, projectId, images: [registered] }),
    ).rejects.toThrow(/Image not found/);
    await expect(
      sendUserMessage(t, {
        conversationId,
        projectId,
        images: Array(5).fill(registered),
        ownerId: ALICE,
      }),
    ).rejects.toThrow(/At most 4 images/);
  });

  test("project deletion removes its chat images and their blobs", async () => {
    const { t, alice, projectId, upload } = await setup();
    const storageId = await upload("image/webp");
    await alice.mutation(api.chatImages.register, { projectId, storageId });

    await t.run(async (ctx) => {
      while (!(await deleteProjectBatch(ctx, projectId))) {
        // Each call deletes one batch.
      }
    });

    expect(await t.run((ctx) => ctx.db.query("chatImages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
  });
});
