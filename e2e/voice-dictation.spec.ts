import { expect, type Page, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

type DictationWindow = Window & { __speak?: (text: string) => void };

/**
 * A stand-in for the browser's speech recognition: start/stop fire the
 * events a real one does, and `window.__speak(text)` delivers a final result.
 */
const mockSpeechRecognition = (page: Page) =>
  page.addInitScript(() => {
    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      start() {
        (window as DictationWindow).__speak = (text: string) => {
          const result = Object.assign([{ transcript: text, confidence: 1 }], { isFinal: true });
          this.onresult?.({ resultIndex: 0, results: [result] });
        };
        setTimeout(() => this.onstart?.(), 0);
      }
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
    }
    Object.assign(window, {
      SpeechRecognition: MockSpeechRecognition,
      webkitSpeechRecognition: MockSpeechRecognition,
    });
  });

// #301: dictation in the dashboard and IDE composers.
test.describe("voice dictation", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("dashboard: dictation appends to typed text and toggles with the button, Alt+V and blur", async ({
    page,
  }) => {
    await mockSpeechRecognition(page);
    await signIn(page);
    await page.goto("/");
    const composer = page.getByRole("main").getByRole("textbox", { name: "Describe what you want to build" });
    const start = page.getByRole("main").getByRole("button", { name: "Start dictation" });

    await composer.fill("Build a");
    await start.click();
    const stop = page.getByRole("main").getByRole("button", { name: "Stop dictation" });
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Dictation started" })).toHaveCount(1);

    await page.evaluate(() => (window as DictationWindow).__speak?.("todo app"));
    await expect(composer).toHaveValue("Build a todo app");

    await page.keyboard.press("Alt+v");
    await expect(start).toHaveAttribute("aria-pressed", "false");
    await expect(composer).toHaveValue("Build a todo app");

    await page.keyboard.press("Alt+v");
    await expect(stop).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(start).toHaveAttribute("aria-pressed", "false");
  });

  test("no button where the browser has no speech recognition", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined });
    });
    await signIn(page);
    await page.goto("/");
    await expect(
      page.getByRole("main").getByRole("textbox", { name: "Describe what you want to build" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start dictation" })).toHaveCount(0);
  });

  test("IDE: the chat composer has the button and it toggles", async ({ page }) => {
    test.skip(!hasPreviewFixtureEnv(), "needs NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY");
    test.setTimeout(120_000);
    await mockSpeechRecognition(page);
    await signIn(page);
    const projectId = await seedPreviewProject(page, "e2e-voice-dictation");
    await page.goto(`/projects/${projectId}`);

    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(composer).toBeVisible({ timeout: 60_000 });
    // The dev-tools badge covers the bottom-left corner, over the tool row.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.getByRole("button", { name: "Start dictation" }).click();
    await page.evaluate(() => (window as DictationWindow).__speak?.("Make the header sticky"));
    await expect(composer).toHaveValue("Make the header sticky");
    await page.getByRole("button", { name: "Stop dictation" }).click();
    await expect(page.getByRole("button", { name: "Start dictation" })).toHaveAttribute("aria-pressed", "false");
  });
});
