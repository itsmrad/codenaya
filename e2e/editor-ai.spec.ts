import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-editor-ai";
const FILE_NAME = "math.ts";
const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

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

test.describe("editor AI", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl || !process.env.OPENROUTER_API_KEY,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL, CODENAYA_CONVEX_INTERNAL_KEY and OPENROUTER_API_KEY",
  );

  test("shows a ghost-text suggestion and applies a Cmd+K quick edit", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}?engine=webcontainer`);
    await page.getByRole("button", { name: FILE_NAME, exact: true }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("return a + b;");

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

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });
});
