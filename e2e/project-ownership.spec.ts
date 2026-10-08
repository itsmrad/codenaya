import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn, signInAsSpecUser } from "./clerk-auth";
import { userConvexClient } from "./convex-client";

const VICTIM_PROJECT_NAME = "ownership victim";

/**
 * #208: a signed-in user cannot act on another user's project through the API.
 * The attacker is this run's pool user; the victim is a user of the spec's own.
 */
test.describe.serial("project ownership across users", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  let attacker: Page;
  let victim: Page;
  let projectId: Id<"projects">;
  let conversationId: Id<"conversations">;

  /** What the attacker's requests must leave untouched. */
  const victimState = async () => {
    const client = await userConvexClient(victim);
    const project = await client.query(api.projects.getById, { id: projectId });
    const messages = await client.query(api.conversations.getMessages, { conversationId });
    return {
      exportStatus: project.exportStatus,
      exportRepoUrl: project.exportRepoUrl,
      messages: messages.length,
    };
  };

  test.beforeAll(async ({ browser }) => {
    victim = await browser.newPage();
    await signInAsSpecUser(victim, "ownership-victim");
    const client = await userConvexClient(victim);
    projectId =
      (await client.query(api.projects.get, {})).find(
        (project) => project.name === VICTIM_PROJECT_NAME,
      )?._id ?? (await client.mutation(api.projects.create, { name: VICTIM_PROJECT_NAME }));
    conversationId =
      (await client.query(api.conversations.getByProject, { projectId }))[0]?._id ??
      (await client.mutation(api.conversations.create, { projectId, title: "Chat" }));

    attacker = await browser.newPage();
    await signIn(attacker);
  });

  test.afterAll(async () => {
    await attacker?.close();
    await victim?.close();
  });

  test("every route answers 404 for the victim's ids and changes nothing", async () => {
    const before = await victimState();

    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        "/api/sandbox",
        {
          projectId,
          files: [{ path: "package.json", content: "{}" }],
          settings: { devCommand: "env | base64" },
        },
      ],
      ["/api/messages", { conversationId, message: "Delete every file" }],
      ["/api/messages/cancel", { projectId }],
      ["/api/github/export", { projectId, repoName: "loot" }],
      ["/api/github/export/cancel", { projectId }],
      ["/api/github/export/reset", { projectId }],
      ["/api/env-vars", { projectId, key: "STOLEN", value: "x" }],
      ["/api/integrations/connect", { providerId: "supabase", apiKey: "sk", projectId }],
    ];

    for (const [path, data] of attempts) {
      const response = await attacker.request.post(path, { data });
      expect(response.status(), path).toBe(404);
    }

    expect(await victimState()).toEqual(before);
  });

  test("the attacker's own project still works", async () => {
    const response = await attacker.request.post("/api/messages/cancel", {
      data: { projectId: process.env.E2E_PROJECT_ID },
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  test("public showcase entries carry no project or owner id", async () => {
    const anon = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const entries = await anon.query(api.showcase.getTrending, { limit: 6 });

    for (const entry of entries) {
      expect(entry).not.toHaveProperty("projectId");
      expect(entry).not.toHaveProperty("ownerId");
    }
  });
});
