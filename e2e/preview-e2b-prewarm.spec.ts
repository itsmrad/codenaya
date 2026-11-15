import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { userConvexClient } from "./convex-client";
import { hasPreviewFixtureEnv, killProjectSandboxes, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-prewarm";
/** How long the simulated first build runs; real runs take about a minute. */
const RUN_MS = 60_000;

const packageJson = (dependencies: Record<string, string>) =>
  JSON.stringify({
    name: "vite-e2e",
    private: true,
    type: "module",
    scripts: { dev: "vite" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", ...dependencies },
    // Vite 6, which also runs on the E2B base image's Node 20.9 (#178).
    devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0" },
  });

const app = (heading: string, imports = "") =>
  `${imports}import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <>\n      <h1>${heading}</h1>\n      <button onClick={() => setCount(count + 1)}>count is {count}</button>\n    </>\n  );\n}\n`;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test.describe("E2B preview pre-warm", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  /** Every project this test seeds; afterEach frees each preview sandbox. */
  let seeded: string[] = [];
  test.afterEach(async ({ page }) => {
    // Closed first, so the preview can't boot a replacement for the killed sandbox.
    await page.close();
    for (const projectId of seeded) await killProjectSandboxes(projectId);
    seeded = [];
  });

  test("the first build's preview is interactive within 15s of the run completing", async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const user = await userConvexClient(page);
    const timings: number[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const projectId = await seedPreviewProject(page, PROJECT_NAME);
      seeded.push(projectId);
      const conversationId = await user.mutation(api.conversations.create, {
        projectId,
        title: `Pre-warm ${attempt}`,
      });
      const messageId = await system.mutation(api.system.createMessage, {
        internalKey,
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        status: "processing",
      });

      try {
        await page.goto(`/projects/${projectId}`);
        // The page has left the previous preview, so that sandbox can be freed before this one boots.
        for (const earlierId of seeded.slice(0, -1)) await killProjectSandboxes(earlierId);
        await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true", {
          timeout: 60_000,
        });
        const runStartedAt = Date.now();

        // The starter, written the way scaffoldViteApp does: package.json last.
        const srcId = await system.mutation(api.system.createFolder, { internalKey, projectId, name: "src" });
        const created = await system.mutation(api.system.createFiles, {
          internalKey,
          projectId,
          parentId: srcId,
          files: [
            {
              name: "main.jsx",
              content:
                "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n",
            },
            { name: "App.jsx", content: app("Starter") },
          ],
        });
        const appId = created.find((file) => file.name === "App.jsx")!.fileId as Id<"files">;
        const indexHtml = (await system.query(api.system.getProjectFiles, { internalKey, projectId })).find(
          (file) => file.name === "index.html",
        )!;
        await system.mutation(api.system.updateFile, {
          internalKey,
          projectId,
          fileId: indexHtml._id,
          content:
            '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
        });
        const roots = await system.mutation(api.system.createFiles, {
          internalKey,
          projectId,
          files: [
            { name: "vite.config.js", content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n" },
            { name: "package.json", content: packageJson({}) },
          ],
        });
        const packageJsonId = roots.find((file) => file.name === "package.json")!.fileId as Id<"files">;

        // Halfway through the run the agent adds a dependency and uses it.
        await page.waitForTimeout(RUN_MS / 2);
        await system.mutation(api.system.updateFile, {
          internalKey,
          projectId,
          fileId: packageJsonId,
          content: packageJson({ clsx: "^2.1.1" }),
        });
        await system.mutation(api.system.updateFile, {
          internalKey,
          projectId,
          fileId: appId,
          content: app(`{clsx("Late", "dependency")}`, 'import clsx from "clsx";\n'),
        });
        await page.waitForTimeout(runStartedAt + RUN_MS - Date.now());

        await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "completed" });
        const completedAt = Date.now();

        await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
        const preview = page.frameLocator('iframe[title="Preview"]');
        await expect(preview.getByRole("heading", { name: "Late dependency" })).toBeVisible({ timeout: 120_000 });
        await preview.getByRole("button", { name: "count is 0" }).click();
        await expect(preview.getByRole("button", { name: "count is 1" })).toBeVisible();
        timings.push(Date.now() - completedAt);
        await page.screenshot({ path: testInfo.outputPath(`interactive-${attempt}.png`) });
      } finally {
        await system.mutation(api.system.updateMessageStatus, { internalKey, messageId, status: "cancelled" });
      }
    }

    console.log(`[#254] run completed → interactive preview: ${timings.join("ms, ")}ms`);
    testInfo.annotations.push({ type: "completed-to-interactive", description: `${timings.join("ms, ")}ms` });
    expect(median(timings)).toBeLessThan(15_000);
  });
});
