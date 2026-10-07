import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";

const PROJECT_NAME = "e2e-quick-edit";
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

test.describe("quick edit widget", () => {
  test.skip(
    !hasClerkCredentials() || !internalKey || !convexUrl,
    "Needs CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY",
  );

  test("closes on Escape and stacks below dialogs", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedProject(page);

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: FILE_NAME, exact: true }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("return a + b;");

    const instruction = page.getByPlaceholder("Edit selected code");
    const openQuickEdit = async () => {
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(instruction).toBeVisible();
    };

    // Submit stays disabled until there is an instruction.
    await openQuickEdit();
    const submit = page.getByRole("button", { name: "Submit" });
    await expect(submit).toBeDisabled();
    await instruction.fill("Rename add to sum");
    await expect(submit).toBeEnabled();

    // Escape closes it with focus in the input...
    await instruction.press("Escape");
    await expect(instruction).toHaveCount(0);

    // ...and with focus in the editor.
    await openQuickEdit();
    await editor.focus();
    await page.keyboard.press("Escape");
    await expect(instruction).toHaveCount(0);

    // An open dialog covers the widget instead of the other way round.
    await openQuickEdit();
    await page.getByRole("button", { name: "Integrations" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const box = (await instruction.boundingBox())!;
    const widgetOnTop = await page.evaluate(
      ({ x, y }) => {
        // Radix sets pointer-events: none on body while a modal is open, which
        // hides the widget from elementFromPoint; lift it for the hit test.
        const previous = document.body.style.pointerEvents;
        document.body.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(x, y);
        document.body.style.pointerEvents = previous;
        return Boolean(hit?.closest(".cm-tooltip"));
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(widgetOnTop).toBe(false);

    expect(errors).toEqual([]);
  });
});
