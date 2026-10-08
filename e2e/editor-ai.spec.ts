import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

const PROJECT_NAME = "e2e-editor-ai";
const FILE_NAME = "math.ts";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const hasConvex = hasClerkCredentials() && Boolean(internalKey && convexUrl);
const NEEDS_CONVEX =
  "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY";

// The BYOK checks set the e2e user's default model, which the platform checks
// must not see.
test.describe.configure({ mode: "serial" });

/** Reuses (or creates) the e2e user's fixture project with one known file. */
const seedProject = async (page: Page) => {
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === PROJECT_NAME,
  );
  const projectId =
    existing?._id ?? (await user.mutation(api.projects.create, { name: PROJECT_NAME }));

  const system = new ConvexHttpClient(convexUrl!);
  await system.mutation(api.system.cleanup, { internalKey: internalKey!, projectId });
  await system.mutation(api.system.createFile, {
    internalKey: internalKey!,
    projectId,
    name: FILE_NAME,
    content: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  });

  return projectId;
};

const openFile = async (page: Page, projectId: Id<"projects">) => {
  await page.goto(`/projects/${projectId}?engine=webcontainer`);
  await page.getByRole("button", { name: FILE_NAME, exact: true }).click();
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("return a + b;");
  return editor;
};

/** The #40 checks: ghost-text suggestion, then a Cmd+K quick edit. */
const checkEditorAi = async (page: Page, projectId: Id<"projects">) => {
  const editor = await openFile(page, projectId);

  // Suggestion: start a new statement at the end of the file.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nconst total = add(");
  await expect(editor.locator('span[style*="opacity: 0.4"]')).toBeVisible({
    timeout: 30_000,
  });

  // Quick edit: select the whole file, press Cmd+K and submit an instruction.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+k");
  const instruction = page.getByPlaceholder("Edit selected code");
  await instruction.fill("Rename the function add to sum");
  await instruction.press("Enter");
  await expect(editor).toContainText("function sum(", { timeout: 60_000 });
};

test.describe("editor AI", () => {
  test.skip(
    !hasConvex || !process.env.OPENROUTER_API_KEY,
    `${NEEDS_CONVEX} and OPENROUTER_API_KEY`,
  );

  test("shows a ghost-text suggestion and applies a Cmd+K quick edit", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    await checkEditorAi(page, await seedProject(page));

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});

/**
 * The same checks on the user's default key. A local OpenAI-compatible stub
 * (`stub-provider.ts`) stands in for the provider.
 */
test.describe("editor AI on the user's own key", () => {
  test.skip(!hasConvex, NEEDS_CONVEX);

  const apiKey = `sk-e2e-byok-editor-${Date.now()}-wxyz`;
  const label = `BYOK editor ${Date.now()}`;
  let stub: Awaited<ReturnType<typeof startStubProvider>>;

  test.beforeAll(async () => {
    stub = await startStubProvider(apiKey, {
      object: (request) =>
        JSON.stringify(request.response_format).includes("editedCode")
          ? {
              editedCode:
                "export function sum(a: number, b: number) {\n  return a + b;\n}\n",
            }
          : { suggestion: "1, 2);" },
    });
  });

  test.afterAll(async () => {
    stub?.server.close();
  });

  test("runs suggestions and quick edit on the default key, and links to settings when it is refused", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const user = await userConvexClient(page);
    const projectId = await seedProject(page);

    const response = await page.request.post("/api/ai-providers", {
      data: {
        provider: "custom",
        apiKey,
        label,
        baseUrl: stub.baseUrl,
        modelIds: [STUB_MODEL],
      },
    });
    expect(response.status()).toBe(200);
    const { keyId } = (await response.json()) as { keyId: Id<"aiProviderKeys"> };

    try {
      await user.mutation(api.aiProviders.setPreferences, {
        defaultKeyId: keyId,
        defaultModelId: STUB_MODEL,
      });

      await checkEditorAi(page, projectId);
      // Both requests went to the user's endpoint, on their default model.
      expect(stub.requests.length).toBeGreaterThanOrEqual(2);
      expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));

      // The provider now refuses the key.
      stub.reject();
      const calls = stub.requests.length;
      // The stub's edit kept `return a + b;`, so the file opens as before.
      const editor = await openFile(page, projectId);

      // A refused suggestion stays silent.
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      const suggestion = page.waitForResponse("**/api/suggestion");
      await page.keyboard.type("\nconst total = add(");
      expect((await suggestion).status()).toBe(422);
      await expect(page.getByText(/AI quick edit failed/)).toHaveCount(0);

      // A refused quick edit explains why and links to settings, with no
      // fallback to the platform key.
      const before = await editor.textContent();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("ControlOrMeta+k");
      const instruction = page.getByPlaceholder("Edit selected code");
      await instruction.fill("Rename the function sum to total");
      await instruction.press("Enter");
      await expect(
        page.getByText(new RegExp(`AI quick edit failed: Your ${label} key`)),
      ).toBeVisible({ timeout: 30_000 });
      expect(await editor.textContent()).toBe(before);
      expect(stub.requests.length).toBe(calls);
      const keyStatus = async () =>
        (await user.query(api.aiProviders.list, {})).find((key) => key._id === keyId)?.status;
      await expect.poll(keyStatus).toBe("invalid");

      await page
        .locator("[data-sonner-toast]")
        .getByRole("button", { name: "Settings" })
        .click();
      await expect(page).toHaveURL(/\/settings\/ai-providers$/);
    } finally {
      // Deleting the key also returns the default to the platform.
      await user.mutation(api.aiProviders.remove, { keyId }).catch(() => {});
    }

    expect(
      errors.filter(
        (error) =>
          !error.includes("webcontainer-api.io") &&
          // The refused requests above, logged by the browser.
          !/status of 422/.test(error),
      ),
    ).toEqual([]);
  });
});
