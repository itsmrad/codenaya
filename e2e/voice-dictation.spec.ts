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
 * error. With `canRecord: false` the browser can't record either, so every
 * language dictates through it.
 */
const mockSpeechRecognition = (page: Page, { canRecord = false } = {}) =>
  page.addInitScript((canRecord) => {
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
      ...(!canRecord && { MediaRecorder: undefined }),
    });
  }, canRecord);

/**
 * A microphone and MediaRecorder that record one short WebM clip, or a
 * microphone the user blocked.
 */
const mockMicrophone = (page: Page, { blocked = false } = {}) =>
  page.addInitScript((blocked) => {
    class MockMediaRecorder {
      static isTypeSupported = (type: string) => type === "audio/webm";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(["clip"], { type: "audio/webm" }) });
          this.onstop?.();
        }, 0);
      }
    }
    const getUserMedia = () =>
      blocked
        ? Promise.reject(new DOMException("Permission denied", "NotAllowedError"))
        : Promise.resolve({ getTracks: () => [{ stop() {} }] });
    Object.assign(window, { MediaRecorder: MockMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  }, blocked);

/** `/api/transcribe` answers `text`, recording what it was sent. */
const stubTranscribe = async (page: Page, text: string) => {
  const languages: (string | null)[] = [];
  await page.route("**/api/transcribe", (route) => {
    const body = route.request().postData() ?? "";
    languages.push(/name="language"\r\n\r\n(\w+)/.exec(body)?.[1] ?? null);
    return route.fulfill({ json: { text } });
  });
  return languages;
};

const dashboardComposer = (page: Page) =>
  page.getByRole("main").getByRole("textbox", { name: "Describe what you want to build" });

// #301: dictation in the dashboard and IDE composers.
test.describe("voice dictation", () => {
  test.skip(!hasClerkCredentials(), "needs CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

  test("dashboard: records, transcribes on the server and inserts the text without sending", async ({
    page,
  }) => {
    await mockMicrophone(page);
    const languages = await stubTranscribe(page, "todo app");
    await signIn(page);
    await page.goto("/");
    const composer = dashboardComposer(page);
    const dictate = page.getByRole("main").getByRole("button", { name: "Dictate" });

    await composer.fill("Build a");
    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await dictate.click();

    await expect(composer).toHaveValue("Build a todo app");
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
    await expect(dictate).toBeEnabled();
    // Auto sends no language hint; the model detects it.
    expect(languages).toEqual([null]);
    await expect(page).toHaveURL("/");
  });

  test("server: a blocked microphone says so", async ({ page }) => {
    await mockMicrophone(page, { blocked: true });
    await signIn(page);
    await page.goto("/");
    const dictate = page.getByRole("main").getByRole("button", { name: "Dictate" });

    await dictate.click();

    await expect(page.getByText("Microphone access is blocked").first()).toBeVisible();
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
  });

  test("a language the server doesn't know dictates with the browser's speech", async ({ page }) => {
    await mockSpeechRecognition(page, { canRecord: true });
    await mockMicrophone(page);
    const languages = await stubTranscribe(page, "unused");
    await signIn(page);
    await page.goto("/");
    const composer = dashboardComposer(page);
    const main = page.getByRole("main");

    await main.getByRole("combobox", { name: "Dictation language" }).click();
    await page.getByRole("option", { name: "Japanese (browser speech)" }).click();
    await main.getByRole("button", { name: "Dictate" }).click();
    await page.evaluate(() => (window as DictationWindow).__speak?.("こんにちは"));

    await expect(composer).toHaveValue("こんにちは");
    expect(languages).toEqual([]);
  });

  test("browser speech: dictation appends to typed text and toggles with the button, Alt+V and blur", async ({
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

  test("browser speech: a blocked microphone stops dictation with a message", async ({ page }) => {
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

  test("no button where the browser can neither record nor recognize speech", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        SpeechRecognition: undefined,
        webkitSpeechRecognition: undefined,
        MediaRecorder: undefined,
      });
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
