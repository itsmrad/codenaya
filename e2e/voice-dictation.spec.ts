import { expect, type Page, test } from "@playwright/test";

import { hasClerkCredentials, signIn } from "./clerk-auth";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

type DictationWindow = Window & {
  __speak?: (text: string) => void;
  __speakLater?: (text: string) => void;
  __fail?: (error: string) => void;
};

/**
 * A stand-in for the browser's speech recognition. Like the real one, stop()
 * still delivers words it has heard but not yet returned (`__speakLater`) and
 * abort() drops them; `__speak` delivers a final result now and `__fail` an
 * error.
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
      onerror: ((event: { error: string }) => void) | null = null;
      pending = "";
      deliver(text: string) {
        const result = Object.assign([{ transcript: text, confidence: 1 }], { isFinal: true });
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
      start() {
        Object.assign(window, {
          __speak: (text: string) => this.deliver(text),
          __speakLater: (text: string) => (this.pending = text),
          __fail: (error: string) => {
            this.onerror?.({ error });
            this.onend?.();
          },
        });
        setTimeout(() => this.onstart?.(), 0);
      }
      stop() {
        setTimeout(() => {
          if (this.pending) this.deliver(this.pending);
          this.onend?.();
        }, 0);
      }
      abort() {
        this.pending = "";
        setTimeout(() => this.onend?.(), 0);
      }
    }
    Object.assign(window, {
      SpeechRecognition: MockSpeechRecognition,
      webkitSpeechRecognition: MockSpeechRecognition,
    });
  });

const dashboardComposer = (page: Page) =>
  page.getByRole("main").getByRole("textbox", { name: "Describe what you want to build" });

// #301: dictation in the dashboard and IDE composers.
test.describe("voice dictation", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("dashboard: dictation appends to typed text and toggles with the button, Alt+V and blur", async ({
    page,
  }) => {
    await mockSpeechRecognition(page);
    await signIn(page);
    await page.goto("/");
    const composer = dashboardComposer(page);
    const dictate = page.getByRole("main").getByRole("button", { name: "Dictate" });

    await composer.fill("Build a");
    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Dictation started" })).toHaveCount(1);

    await page.evaluate(() => (window as DictationWindow).__speak?.("todo app"));
    await expect(composer).toHaveValue("Build a todo app");

    // Focus is on the button, inside this composer, so Alt+V reaches it.
    await page.keyboard.press("Alt+v");
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
    await expect(composer).toHaveValue("Build a todo app");

    await page.keyboard.press("Alt+v");
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
  });

  test("a blocked microphone stops dictation with a message", async ({ page }) => {
    await mockSpeechRecognition(page);
    await signIn(page);
    await page.goto("/");
    const dictate = page.getByRole("main").getByRole("button", { name: "Dictate" });

    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => (window as DictationWindow).__fail?.("not-allowed"));

    await expect(page.getByText("Microphone access is blocked").first()).toBeVisible();
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
  });

  test("no button where the browser has no speech recognition", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined });
    });
    await signIn(page);
    await page.goto("/");
    await expect(dashboardComposer(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Dictate" })).toHaveCount(0);
  });

  test("IDE: dictation fills the chat composer and sending stops it without late words", async ({
    page,
  }) => {
    test.skip(!hasPreviewFixtureEnv(), "needs NEXT_PUBLIC_CONVEX_URL and CODENAYA_CONVEX_INTERNAL_KEY");
    test.setTimeout(120_000);
    await mockSpeechRecognition(page);
    // The send fails before any agent run starts; the composer gets its text back.
    await page.route("**/api/messages", (route) => route.fulfill({ status: 500, json: {} }));
    await signIn(page);
    const projectId = await seedPreviewProject(page, "e2e-voice-dictation");
    await page.goto(`/projects/${projectId}`);

    const composer = page.getByPlaceholder("Describe a change or ask a question…");
    await expect(composer).toBeVisible({ timeout: 60_000 });
    // The dev-tools badge covers the bottom-left corner, over the tool row.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const dictate = page.getByRole("button", { name: "Dictate" });

    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => (window as DictationWindow).__speak?.("Make the header sticky"));
    await expect(composer).toHaveValue("Make the header sticky");

    await page.evaluate(() => (window as DictationWindow).__speakLater?.("late words"));
    await composer.press("Enter");
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
    await expect(composer).not.toHaveValue(/late words/);
  });
});
