import { expect, test, type Page } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";

test.describe("IDE top bar", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  for (const width of [768, 1440]) {
    test(`tabs don't overlap the project name at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      await page.goto("/");
      const projectLink = page.locator('a[href^="/projects/"]').first();
      // The project list streams in from Convex after the page renders.
      await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
      test.skip(!(await projectLink.count()), "the e2e user has no projects");
      const href = await projectLink.getAttribute("href");

      await page.goto(href!, { waitUntil: "domcontentloaded" });
      const codeTab = page.getByRole("tab", { name: "Code" });
      await expect(codeTab).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Integrations" })).toBeVisible();

      const nav = page.locator("nav").filter({ has: codeTab });
      const projectName = nav.locator("button").first();
      const nameBox = (await projectName.boundingBox())!;
      const tabBox = (await codeTab.boundingBox())!;
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(tabBox.x);
    });
  }
});

test.describe("IDE responsive layout", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  /** Signs in and opens the e2e user's first project at the given width. */
  const openProject = async (page: Page, width: number) => {
    // The dev-tools badge covers the bottom-left tab. It is re-rendered on
    // hydration, so a style tag added after load doesn't stick.
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.addEventListener("DOMContentLoaded", () => document.body.append(style));
    });
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    await signIn(page);
    await page.goto("/");
    const projectLink = page.locator('a[href^="/projects/"]').first();
    await projectLink.waitFor({ timeout: 30_000 }).catch(() => {});
    test.skip(!(await projectLink.count()), "the e2e user has no projects");
    const href = await projectLink.getAttribute("href");
    // WebContainers need no cloud sandbox, so the preview loads locally.
    await page.goto(`${href}?engine=webcontainer`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Code" })).toBeVisible({ timeout: 60_000 });
  };

  const expectNoHorizontalOverflow = async (page: Page) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };

  /** The composer's send button must not be cut off by the chat panel. */
  const expectSendButtonUnclipped = async (page: Page) => {
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeVisible();
    const clipped = await send.evaluate((button) => {
      const right = button.getBoundingClientRect().right;
      for (let el = button.parentElement; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowX !== "visible") {
          return right - el.getBoundingClientRect().right;
        }
      }
      return 0;
    });
    expect(clipped).toBeLessThanOrEqual(0);
  };

  test("phones switch Chat / Code / Preview with a bottom tab bar", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    await openProject(page, 375);

    const tabBar = page.getByRole("tablist", { name: "Workspace views" });
    const tab = (name: string) => tabBar.getByRole("tab", { name });
    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    const terminalToggle = page.getByRole("button", { name: "Toggle terminal" });

    // Opens on the chat, full width and usable.
    await expect(tab("Chat")).toHaveAttribute("aria-selected", "true");
    await expect(composer).toBeVisible();
    await composer.fill("draft survives tab switches");
    expect((await composer.boundingBox())!.width).toBeGreaterThan(300);
    await expectSendButtonUnclipped(page);

    await tab("Code").click();
    await expect(tab("Code")).toHaveAttribute("aria-selected", "true");
    await expect(composer).toBeHidden();
    await expect(page.getByRole("button", { name: "Create file", exact: true })).toBeVisible();

    await tab("Preview").click();
    await expect(terminalToggle).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await tab("Chat").click();
    await expect(terminalToggle).toBeHidden();
    await expect(composer).toHaveValue("draft survives tab switches");
    await expectNoHorizontalOverflow(page);

    // The WebContainer preview iframe serves the generated app, not ours.
    expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
  });

  for (const width of [768, 900, 1023]) {
    test(`tablets switch Chat / Code / Preview from the top bar at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors = collectConsoleErrors(page);
      await openProject(page, width);

      const nav = page.locator("nav");
      const tab = (name: string) => nav.getByRole("tab", { name });
      const composer = page.getByPlaceholder("Describe a change or ask a question…");

      // No phone tab bar; the chat opens as its own full-width view.
      await expect(page.getByRole("tablist", { name: "Workspace views" })).toHaveCount(0);
      await expect(tab("Chat")).toHaveAttribute("aria-selected", "true");
      await expect(composer).toBeVisible();
      await composer.fill("draft survives tab switches");
      expect((await composer.boundingBox())!.width).toBeGreaterThan(width - 100);
      await expectSendButtonUnclipped(page);

      // The code view gets the whole width, explorer beside the editor.
      await tab("Code").click();
      await expect(composer).toBeHidden();
      await expect(page.getByRole("button", { name: "Create file", exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await tab("Chat").click();
      await expect(composer).toHaveValue("draft survives tab switches");
      await expectNoHorizontalOverflow(page);

      expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
    });
  }

  for (const width of [1024, 1440]) {
    test(`desktops keep chat beside the editor at ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors = collectConsoleErrors(page);
      await openProject(page, width);

      await expect(page.getByRole("tablist", { name: "Workspace views" })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Chat" })).toHaveCount(0);
      const composer = page.getByPlaceholder("Describe a change or ask a question…");
      await expect(composer).toBeVisible();
      await composer.fill("hello");
      await expectSendButtonUnclipped(page);
      await expectNoHorizontalOverflow(page);

      expect(errors.filter((error) => !error.includes("webcontainer-api.io"))).toEqual([]);
    });
  }
});
