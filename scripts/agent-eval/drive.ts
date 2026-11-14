import { mkdir, writeFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import type { Page } from "@playwright/test";
import { userConvexClient } from "../../e2e/convex-client";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { capture, probePreview, sanitize, screenshot } from "./capture";
import { readUsage, recordUsage, totalUsd } from "./cost";
import type { Trail } from "./types";

type Options = { id: string; model: string; prompt: string; maxUsd: number; directory: string; projectId?: Id<"projects"> };

export async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, { data, timeout: 60_000 });
  if (!response.ok()) throw new Error(`${path}: HTTP ${response.status()} ${await response.text()}`);
  return response.json();
}

/** Observe through the two-minute client auto-fix window, including new runs. */
async function observe(page: Page, user: ConvexHttpClient, options: Options, trail: Trail) {
  const projectId = trail.projectId as Id<"projects">;
  user = await userConvexClient(page);
  const conversations = await user.query(api.conversations.getByProject, { projectId });
  const conversationId = conversations[0]?._id;
  if (!conversationId) throw new Error("Created project has no conversation");
  const deadline = Date.now() + 20 * 60_000;
  let idleSince = 0;
  while (Date.now() < deadline) {
    user = await userConvexClient(page); // Clerk JWTs expire during long builds.
    const all = await user.query(api.conversations.getMessages, { conversationId });
    trail.messages = all.filter((m) => m._creationTime >= trail.startedAt);
    const assistants = trail.messages.filter((m) => m.role === "assistant");
    const ids = new Set(assistants.map((m) => String(m._id)));
    const usage = (await readUsage()).filter((r) => ids.has(r.messageId));
    if (trail.usage.some((r) => !usage.some((next) => next.messageId === r.messageId))) throw new Error("Active run fell outside the 200-row metering window");
    trail.usage = usage;
    await recordUsage(trail.id, trail.usage);
    for (const message of assistants) {
      if (message.runModel && (message.runModel.modelId !== options.model || message.runModel.keyId)) throw new Error(`runModel mismatch: requested platform ${options.model}, got ${message.runModel.modelId}`);
    }
    if (totalUsd(trail.usage) >= options.maxUsd) {
      trail.capped = true;
      await post(page, "/api/messages/cancel", { projectId });
    }
    await probePreview(page, trail);
    const active = await user.query(api.conversations.getActiveRun, { projectId });
    const done = assistants.length > 0 && assistants.every((m) => m.status === "completed" || m.status === "cancelled");
    if (!active && done) {
      idleSince ||= Date.now();
      // 130s covers the 2-minute auto-fix window plus its 3s debounce.
      if (trail.capped || Date.now() - idleSince >= 130_000) {
        if (assistants.some((m) => !m.runModel)) throw new Error("Missing runModel on assistant message");
        if (assistants.some((m) => !trail.usage.some((r) => r.messageId === m._id))) throw new Error("Missing creditLedger row for completed run");
        return;
      }
    } else idleSince = 0;
    if (trail.capped) throw new Error("Cancelled run did not become idle");
    await page.waitForTimeout(10_000);
  }
  throw new Error("Run timed out after 20 minutes");
}

export async function drive(page: Page, user: ConvexHttpClient, options: Options) {
  const trail: Trail = { id: options.id, model: options.model, prompt: options.prompt, startedAt: Date.now(), endedAt: 0, messages: [], usage: [], sandboxEvents: [], consoleErrors: [], capped: false, preview: { loaded: false, overlay: false } };
  await mkdir(options.directory, { recursive: true });
  await capture(page, trail);
  try {
    await readUsage(); // Fail before creating anything if metering is unavailable.
    if (options.projectId) {
      trail.projectId = options.projectId;
      const conversations = await user.query(api.conversations.getByProject, { projectId: options.projectId });
      await post(page, "/api/messages", { conversationId: conversations[0]._id, message: options.prompt, model: options.model });
    } else {
      const result = await post(page, "/api/projects/create-with-prompt", { prompt: options.prompt, model: options.model });
      trail.projectId = result.projectId;
    }
    await page.goto(`/projects/${trail.projectId}`);
    await page.getByRole("tab", { name: "Preview", exact: true }).click({ timeout: 60_000 });
    await observe(page, user, options, trail);
    if (trail.preview.loaded || trail.preview.overlay) await screenshot(page, options.directory, trail);
  } catch (error) {
    trail.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (trail.projectId) {
      // Stop through the app path before ending observation, including failures.
      try { await post(page, "/api/messages/cancel", { projectId: trail.projectId }); }
      catch (error) { trail.error = `${trail.error ?? ""}; cleanup cancel: ${String(error)}`; }
      for (const id of new Set(trail.sandboxEvents.map((e) => e.sandboxId).filter(Boolean))) {
        const result = await page.request.delete(`/api/sandbox/${id}`);
        if (!result.ok() && result.status() !== 404) trail.error = `${trail.error ?? ""}; sandbox cleanup HTTP ${result.status()}`;
      }
    }
    trail.endedAt = Date.now();
    await writeFile(`${options.directory}/trail.json`, sanitize(trail));
  }
  return trail;
}

export async function finalFiles(projectId: string) {
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const files = await client.query(api.system.getProjectFilesWithUrls, { internalKey: process.env.CODENAYA_CONVEX_INTERNAL_KEY!, projectId: projectId as Id<"projects"> });
  return files.filter((f) => f.type === "file" && typeof f.content === "string").map((f) => ({ path: f.path, content: f.content! }));
}
