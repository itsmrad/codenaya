import { expect, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { userConvexClient } from "./convex-client";

export const hasInternalKey = () => Boolean(process.env.CODENAYA_CONVEX_INTERNAL_KEY);

/** A pasted Vite error: long unbroken paths plus a code frame. */
export const MULTI_LINE_MESSAGE = `The preview stopped working:

[plugin:vite:import-analysis] Failed to resolve import "@/pages/index" from "src/main.tsx". Does the file exist?
/home/user/app/src/main.tsx:3:17
1  |  import React from "react";
2  |  import { createRoot } from "react-dom/client";
3  |  import Home from "@/pages/index";
   |                    ^
4  |  import "./index.css";
5  |  createRoot(document.getElementById("root")!).render(<React.StrictMode><Home /></React.StrictMode>);
    at TransformPluginContext._formatError (file:///home/user/app/node_modules/vite/dist/node/chunks/dep-BWSbWtLw.js:49257:41)
    at TransformPluginContext.error (file:///home/user/app/node_modules/vite/dist/node/chunks/dep-BWSbWtLw.js:49252:16)
    at normalizeUrl (file:///home/user/app/node_modules/vite/dist/node/chunks/dep-BWSbWtLw.js:64199:23)`;

export const LONG_SINGLE_LINE_MESSAGE = `Use this asset https://example.com/${"very-long-path-segment-".repeat(12)}hero.png and this token ${"a".repeat(240)} please.`;

const READ_FILES = [
  "vite.config.ts", "src/main.tsx", "src/pages/index.tsx", "package.json", "tsconfig.json",
  "src/lib/index.ts", "src/hooks/useTypewriter.ts", "index.html", "tsconfig.node.json",
  "src/index.css", "tailwind.config.ts", "src/components/ui/button.tsx",
  "src/components/ui/input.tsx", "src/components/ui/separator.tsx", "src/lib/utils.ts",
  "postcss.config.js", "components.json",
];

const ASSISTANT_MARKDOWN = `Fixed the import. The landing page lives at \`src/pages/index.tsx\`, see https://vitejs.dev/guide/features.html#${"anchor-".repeat(20)}end for details.

\`\`\`ts
export default defineConfig({ plugins: [react()], resolve: { alias: { "@": path.resolve(__dirname, "./src"), "~components": path.resolve(__dirname, "./src/components") } } });
\`\`\``;

const fileSteps = (now: number) => [
  { id: "list", kind: "tool" as const, tool: "listFiles", targets: ["src"], status: "done" as const, startedAt: now, endedAt: now },
  ...READ_FILES.map((path, index) => ({
    id: `read-${index}`,
    kind: "tool" as const,
    tool: "readFiles",
    targets: [path],
    status: "done" as const,
    startedAt: now,
    endedAt: now,
  })),
];

/**
 * Seeds a fresh conversation (it becomes the active one) with long user
 * messages, a finished run with an error step and a live run with many reads.
 * Returns a cleanup that stops the live run.
 */
export const seedOverflowConversation = async (page: Page, projectId: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const user = await userConvexClient(page);
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const project = projectId as Id<"projects">;
  const conversationId = await user.mutation(api.conversations.create, {
    projectId: project,
    title: `Overflow check ${Date.now()}`,
  });
  const create = (role: "user" | "assistant", content: string, status?: "processing" | "completed") =>
    system.mutation(api.system.createMessage, { internalKey, conversationId, projectId: project, role, content, status });
  const now = Date.now();

  await create("user", LONG_SINGLE_LINE_MESSAGE);
  const done = await create("assistant", "", "processing");
  await system.mutation(api.system.upsertMessageSteps, {
    internalKey,
    messageId: done,
    steps: [
      ...fileSteps(now),
      { id: "edit", kind: "tool", tool: "updateFile", targets: ["src/main.tsx"], status: "error", error: `Patch failed: ${"no match for the search block ".repeat(6)}`, startedAt: now, endedAt: now },
    ],
  });
  await system.mutation(api.system.updateMessageContent, { internalKey, messageId: done, content: ASSISTANT_MARKDOWN });

  await create("user", MULTI_LINE_MESSAGE);
  const live = await create("assistant", "", "processing");
  await system.mutation(api.system.upsertMessageSteps, { internalKey, messageId: live, steps: fileSteps(now) });

  return () =>
    system.mutation(api.system.updateMessageStatus, { internalKey, messageId: live, status: "cancelled" });
};

/** Drags the chat/editor sash so the chat panel is `width` px wide (desktop layout). */
export const setChatPanelWidth = async (page: Page, width: number) => {
  const panel = page.locator('[role="log"]');
  const sash = page.locator('[class*="sash-module_sash"]').first();
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = (await panel.boundingBox())!.width;
    if (Math.abs(current - width) <= 2) return;
    const box = (await sash.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (width - current), y, { steps: 5 });
    await page.mouse.up();
  }
  expect(Math.abs((await panel.boundingBox())!.width - width)).toBeLessThanOrEqual(2);
};

/**
 * Elements of the chat transcript that stick out of it horizontally. Content
 * inside its own clipping or scrolling box (a code block) is that box's
 * business, so only the box itself is checked.
 */
export const chatOverflow = (page: Page) =>
  page.locator('[role="log"]').evaluate((log) => {
    const bounds = log.getBoundingClientRect();
    const offenders: string[] = [];
    const visit = (element: Element) => {
      for (const child of Array.from(element.children)) {
        const rect = child.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) {
          offenders.push(`${child.tagName.toLowerCase()}.${String(child.className).slice(0, 60)} [${Math.round(rect.left)}, ${Math.round(rect.right)}]`);
        }
        if (getComputedStyle(child).overflowX === "visible") visit(child);
      }
    };
    // The transcript scroller itself is the first clipping box.
    const scroller = Array.from(log.querySelectorAll("*")).find(
      (element) => /auto|scroll/.test(getComputedStyle(element).overflowY),
    );
    visit(scroller ?? log);
    return offenders;
  });
