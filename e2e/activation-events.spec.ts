import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv } from "./preview-fixtures";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

/**
 * Activation events (#339) from a new project built from a prompt, on a stub
 * provider (see `stub-provider.ts`), so this needs the Inngest dev server
 * serving this app, as in `byok-agent-run.spec.ts`. Events are read back with
 * `system.getActivationEvents`.
 *
 * The stub agent only lists files, so the spec writes the root `package.json`
 * itself, through the same `system.createFiles` the agent's tools use. The
 * preview runs on a stubbed `/api/sandbox`, which never calls
 * `recordSandboxRunning`, so `sandbox_running` isn't checked here;
 * `convex/activationEvents.test.ts` covers it.
 */

const STUB_REPLY = "Listed the files";

/**
 * The sandbox boot resolves at once, on a served page. Not `about:blank`: its
 * load fires synchronously on insert, before React can see it, so the preview
 * never counts as loaded.
 */
const stubSandbox = async (page: Page) => {
  const previewUrl = new URL("/__e2e-activation-preview", page.url()).href;
  await page.route(previewUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Hello</h1>" }),
  );
  await page.route("**/api/sandbox", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ type: "ready", sandboxId: "e2e-sandbox", previewUrl })}\n`,
    }),
  );
  // File sync and teardown of the stubbed sandbox.
  await page.route("**/api/sandbox/**", (route) => route.fulfill({ json: {} }));
};

test.describe.serial("activation events", () => {
  test.skip(
    !hasClerkCredentials(),
    "Needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  );
  test.skip(
    !hasPreviewFixtureEnv(),
    "Needs CODENAYA_CONVEX_INTERNAL_KEY and NEXT_PUBLIC_CONVEX_URL",
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

  test("a new project from a prompt records each step to its first preview", async () => {
    test.setTimeout(240_000);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const eventNames = async () =>
      (await system.query(api.system.getActivationEvents, { internalKey, projectId })).map(
        (event) => event.name,
      );

    // The dashboard and landing composers post here to start a project.
    const response = await page.request.post("/api/projects/create-with-prompt", {
      data: {
        prompt: `activation e2e ${Date.now()}: list the files`,
        model: { keyId, modelId: STUB_MODEL },
      },
    });
    expect(response.status()).toBe(200);
    projectId = (await response.json()).projectId;

    await expect.poll(eventNames, { timeout: 120_000 }).toContain("run_finished");
    expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));

    await system.mutation(api.system.createFiles, {
      internalKey,
      projectId,
      files: [
        { name: "package.json", content: "{}\n" },
        { name: "index.html", content: "<h1>Hello</h1>\n" },
      ],
    });

    await stubSandbox(page);
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();
    await expect(page.locator('iframe[title="Preview"]')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.frameLocator('iframe[title="Preview"]').getByRole("heading", { name: "Hello" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(eventNames, { timeout: 30_000 }).toContain("first_preview_shown");

    const events = await system.query(api.system.getActivationEvents, { internalKey, projectId });
    expect(new Set(events.map((event) => event.name))).toEqual(
      new Set([
        "project_created",
        "run_started",
        "first_build_started",
        "run_finished",
        "package_json_ready",
        "first_preview_shown",
      ]),
    );
    const at = (name: string) => events.find((event) => event.name === name)!.at;
    expect(at("project_created")).toBeLessThanOrEqual(at("run_started"));
    expect(at("run_started")).toBeLessThanOrEqual(at("run_finished"));
    expect(at("package_json_ready")).toBeLessThanOrEqual(at("first_preview_shown"));
    // The stub run ended ok: `projects.get` derives "done" from these events.
    const user = await userConvexClient(page);
    expect(
      (await user.query(api.projects.get, {})).find((project) => project._id === projectId)?.lastRun,
    ).toBe("done");
  });
});
