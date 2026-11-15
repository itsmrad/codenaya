import { expect, test, type Page } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Activation events (#339) from a new project built from a prompt, on a stub
 * provider (see `stub-provider.ts`), so this needs the Inngest dev server
 * serving this app, as in `byok-agent-run.spec.ts`.
 *
 * Events have no read path outside `internal.activationEvents.report`, so this
 * reads them through `projects.get`'s `lastRun`, which is derived from the
 * owner's `run_started` and `run_finished` events: "done" needs both, with an
 * `ok` outcome. `project_created`, `package_json_ready`, `sandbox_running` and
 * `first_preview_shown` can't be read back without a new query; convex-test
 * covers them in `convex/activationEvents.test.ts`.
 */

const STUB_REPLY = "Listed the files";

test.describe.serial("activation events", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );

  const apiKey = `sk-e2e-activation-${Date.now()}-wxyz`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;
  let page: Page;
  let keyId: Id<"aiProviderKeys">;
  let projectId: Id<"projects">;

  test.beforeAll(async ({ browser }) => {
    stub = await startStubProvider(apiKey, { reply: STUB_REPLY });
    page = await browser.newPage();
    await signIn(page);

    const response = await page.request.post("/api/ai-providers", {
      data: {
        provider: "custom",
        apiKey,
        label: `Activation ${Date.now()}`,
        baseUrl: stub.baseUrl,
        modelIds: [STUB_MODEL],
      },
    });
    expect(response.status()).toBe(200);
    keyId = (await response.json()).keyId;
  });

  test.afterAll(async () => {
    if (!page) return;
    const user = await userConvexClient(page);
    if (keyId) await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    if (projectId) await user.mutation(api.projects.remove, { id: projectId }).catch(() => {});
    await page.close();
    stub?.server.close();
  });

  test("a new project from a prompt records run_started and run_finished", async () => {
    test.setTimeout(180_000);

    // The dashboard and landing composers post here to start a project.
    const response = await page.request.post("/api/projects/create-with-prompt", {
      data: {
        prompt: `activation e2e ${Date.now()}: list the files`,
        model: { keyId, modelId: STUB_MODEL },
      },
    });
    expect(response.status()).toBe(200);
    projectId = (await response.json()).projectId;

    const user = await userConvexClient(page);
    await expect
      .poll(
        async () =>
          (await user.query(api.projects.get, {})).find((project) => project._id === projectId)
            ?.lastRun,
        { timeout: 120_000 },
      )
      .toBe("done");
    expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));
  });
});
