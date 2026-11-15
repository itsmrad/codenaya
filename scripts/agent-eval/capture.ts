import type { Page } from "@playwright/test";
import type { SandboxEvent, Trail } from "./types";

/** Persist diagnostics, never cookies, headers, env values, or signed URLs. */
export function sanitize(value: unknown): string {
  let text = JSON.stringify(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|KEK|EMAIL/.test(name) && secret && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  }
  const email = process.env.ADMIN_EMAIL?.trim();
  if (email) text = text.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]");
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

/**
 * Whether the preview shows the generated app: text other than the seeded starter's lone "App" heading, and not
 * the starter's error boundary (`role="alert"`, "Something went wrong"; vite-starter.ts). An app that renders only
 * images or a canvas has no text, so its first paint is never recorded.
 */
export const isGeneratedApp = (rootText: string, errorBoundary = false) => {
  const text = rootText.trim();
  return !errorBoundary && text !== "" && text !== "App" && !text.startsWith("Something went wrong");
};

export async function probePreview(page: Page, trail: Trail) {
  const preview = page.frameLocator('iframe[title="Preview"]');
  if (await page.locator('iframe[title="Preview"]').count() === 0) return;
  const loaded = await preview.locator("#root > *").count() > 0;
  const overlay = await preview.locator("vite-error-overlay").count() > 0;
  if ((loaded || overlay) && !trail.firstPreviewAt) trail.firstPreviewAt = Date.now();
  if (loaded && !trail.firstAppPaintAt) {
    const text = await preview.locator("#root").innerText().catch(() => "");
    if (isGeneratedApp(text, await preview.locator('#root > [role="alert"]').count() > 0)) trail.firstAppPaintAt = Date.now();
  }
  trail.preview.loaded = loaded;
  trail.preview.overlay = overlay;
}

/** "/" keeps the original app.png; "/menu" → app-menu.png. */
export const screenshotFile = (route: string) => route === "/" ? "app.png" : `app${route.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "")}.png`;

/** The preview URL with the route's path, keeping the sandbox host and any query. */
export const routeUrl = (src: string, route: string) => { const url = new URL(src); url.pathname = route; return url.toString(); };

/** Each route on a fresh load, scrolled top to bottom first so scroll-reveal sections render in the full-page capture. */
export async function screenshot(page: Page, directory: string, trail: Trail, routes = ["/"]) {
  const src = await page.locator('iframe[title="Preview"]').getAttribute("src");
  if (!src || !isAppUrl(src)) throw new Error("No E2B iframe URL for app screenshot");
  const app = await page.context().newPage();
  try {
    trail.preview.errors = [];
    trail.preview.screenshots = [];
    app.on("console", (message) => {
      if (message.type() !== "error" || !isAppUrl(message.location().url)) return;
      trail.consoleErrors.push({ text: message.text(), url: message.location().url });
      trail.preview.errors!.push(message.text()); // A fresh load: build-time errors excluded.
    });
    for (const route of routes) {
      await app.goto(routeUrl(src, route), { waitUntil: "domcontentloaded", timeout: 90_000 }); // A loaded Mac or cold sandbox can take over 30s.
      await app.locator("#root > *, vite-error-overlay").first().waitFor({ timeout: 90_000 });
      await app.waitForTimeout(route === routes[0] ? 5_000 : 2_000);
      // Capped, so an infinite-scroll page cannot keep growing under the loop.
      for (let y = 0; y < Math.min(20_000, await app.evaluate(() => document.documentElement.scrollHeight)); y += 600) {
        await app.evaluate((top) => window.scrollTo(0, top), y);
        await app.waitForTimeout(300);
      }
      await app.evaluate(() => window.scrollTo(0, 0));
      await app.waitForTimeout(500);
      const file = screenshotFile(route);
      await app.screenshot({ path: `${directory}/${file}`, fullPage: true });
      trail.preview.screenshots.push({ route, file });
    }
    trail.preview.screenshot = trail.preview.screenshots[0]?.file;
  } finally { await app.close(); }
}
