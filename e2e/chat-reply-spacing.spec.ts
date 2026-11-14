import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasInternalKey } from "./chat-fixtures";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

// Regression for #467: a reply's first and last blocks (heading, list, code)
// kept their outer margins, padding the reply box above and below the text.
const REPLIES = [
  "Added a pricing section.",
  "## Summary\n\nThe heading leads the reply.",
  "Changes:\n\n- One item\n- Two items",
  "Run this:\n\n```ts\nconst a = 1;\n```",
];

test.describe("chat reply spacing", () => {
  test.skip(
    !hasClerkCredentials() || !hasInternalKey() || !hasPreviewFixtureEnv(),
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CODENAYA_CONVEX_INTERNAL_KEY and NEXT_PUBLIC_CONVEX_URL",
  );

  test("a reply box ends at its text and sits 8px above its actions", async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const projectId = (await seedPreviewProject(page, "e2e chat reply spacing")) as Id<"projects">;
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const user = await userConvexClient(page);
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const conversationId = await user.mutation(api.conversations.create, {
      projectId,
      title: `Reply spacing ${Date.now()}`,
    });
    for (const content of REPLIES) {
      const create = (role: "user" | "assistant", text: string) =>
        system.mutation(api.system.createMessage, {
          internalKey, conversationId, projectId, role, content: text,
          ...(role === "assistant" ? { status: "processing" as const } : {}),
        });
      await create("user", "Go");
      const messageId = await create("assistant", "");
      await system.mutation(api.system.updateMessageContent, { internalKey, messageId, content });
    }

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    const replies = page.locator(".chat-prose");
    await expect(replies).toHaveCount(REPLIES.length, { timeout: 60_000 });

    const gaps = await replies.evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        const first = el.firstElementChild!.getBoundingClientRect();
        const last = el.lastElementChild!.getBoundingClientRect();
        const actions = el.nextElementSibling!.getBoundingClientRect();
        return { top: first.top - box.top, bottom: box.bottom - last.bottom, actions: actions.top - box.bottom };
      }),
    );
    expect(gaps).toEqual(REPLIES.map(() => ({ top: 0, bottom: 0, actions: 8 })));
  });
});
