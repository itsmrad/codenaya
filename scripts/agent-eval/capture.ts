import type { Page } from "@playwright/test";
import type { SandboxEvent, Trail } from "./types";

/** Persist diagnostics, never cookies, headers, env values, or signed URLs. */
export function sanitize(value: unknown): string {
  let text = JSON.stringify(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|KEK/.test(name) && secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:https?|wss?):[^\s"\\?]+)\?[^\s"\\]+/g, "$1?[REDACTED]");
}

export async function capture(page: Page, trail: Trail) {
  page.on("console", (message) => {
    if (message.type() === "error" && isAppUrl(message.location().url)) trail.consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  await page.exposeBinding("evalSandboxEvent", (_source, event: SandboxEvent) => {
    trail.sandboxEvents.push({ at: Date.now(), type: event.type, code: event.code, message: event.message, phase: event.phase, data: event.data, sandboxId: event.sandboxId });
  });
  // response.body() waits for this long-lived NDJSON response to close. Read a
  // clone in the browser so ready/error events arrive while the stream is open.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      const url = new URL(response.url);
      if (url.pathname === "/api/sandbox" && response.body) {
        void (async () => {
          const reader = response.clone().body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line.trim()) await (window as unknown as { evalSandboxEvent: (event: unknown) => Promise<void> }).evalSandboxEvent(JSON.parse(line));
            }
          }
        })().catch(() => { /* Navigation aborts the stream; server errors are NDJSON events. */ });
      }
      return response;
    };
  });
}

// E2B's proxy refuses Vite's HMR websocket while the app itself runs fine.
const HMR_NOISE = [/^WebSocket connection to 'wss:\/\/[^']*' failed/, /^\[vite\] failed to connect to websocket/];
export const isHmrNoise = (text: string) => HMR_NOISE.some((pattern) => pattern.test(text));
/** Uncaught render errors, which leave an error boundary instead of the app. */
export const isRuntimeError = (text: string) => /\b(?:TypeError|ReferenceError)\b|Cannot read properties of/.test(text);

export const isAppUrl = (url: string) => {
  try { return /\.(?:e2b\.app|e2b\.dev)$/.test(new URL(url).hostname); } catch { return false; }
};

export async function probePreview(page: Page, trail: Trail) {
  const preview = page.frameLocator('iframe[title="Preview"]');
  if (await page.locator('iframe[title="Preview"]').count() === 0) return;
  const loaded = await preview.locator("#root > *").count() > 0;
  const overlay = await preview.locator("vite-error-overlay").count() > 0;
  if ((loaded || overlay) && !trail.firstPreviewAt) trail.firstPreviewAt = Date.now();
  trail.preview.loaded = loaded;
  trail.preview.overlay = overlay;
}

export async function screenshot(page: Page, directory: string, trail: Trail) {
  const src = await page.locator('iframe[title="Preview"]').getAttribute("src");
  if (!src || !isAppUrl(src)) throw new Error("No E2B iframe URL for app screenshot");
  const app = await page.context().newPage();
  try {
    trail.preview.errors = [];
    app.on("console", (message) => {
      if (message.type() !== "error" || !isAppUrl(message.location().url)) return;
      trail.consoleErrors.push({ text: message.text(), url: message.location().url });
      trail.preview.errors!.push(message.text()); // A fresh load: build-time errors excluded.
    });
    await app.goto(src, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await app.locator("#root > *, vite-error-overlay").first().waitFor({ timeout: 30_000 });
    await app.waitForTimeout(5_000);
    await app.screenshot({ path: `${directory}/app.png`, fullPage: true });
    trail.preview.screenshot = "app.png";
  } finally { await app.close(); }
}
