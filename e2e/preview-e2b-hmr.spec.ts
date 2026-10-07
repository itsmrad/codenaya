import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { hasPreviewFixtureEnv, seedPreviewProject } from "./preview-fixtures";

const PROJECT_NAME = "e2e-preview-e2b-hmr";

const app = (text: string) =>
  `export default function App() {\n  return <h1>${text}</h1>;\n}\n`;

/** Smallest Vite + React app. Vite 6, because the E2B base image ships Node 20.9. */
const ROOT_FILES = [
  {
    name: "package.json",
    content: JSON.stringify({
      name: "hmr-e2e",
      private: true,
      type: "module",
      scripts: { dev: "vite" },
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0" },
    }),
  },
  {
    name: "vite.config.js",
    content:
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n",
  },
  {
    name: "index.html",
    content:
      '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
  },
];

test.describe("E2B preview hot reload", () => {
  test.skip(
    !hasClerkCredentials() || !hasPreviewFixtureEnv() || !process.env.E2B_API_KEY,
    "Needs Clerk and Convex fixture env plus E2B_API_KEY (boots a real sandbox)",
  );

  test("an edit hot-updates the preview without a reload or websocket errors", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = collectConsoleErrors(page);

    await signIn(page);
    const projectId = await seedPreviewProject(page, PROJECT_NAME);
    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
    const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const roots = await system.mutation(api.system.createFiles, {
      internalKey,
      projectId,
      files: ROOT_FILES,
    });
    // The fixture already seeded an index.html; replace it with the Vite entry.
    for (const root of roots.filter((file) => file.error)) {
      await system.mutation(api.system.updateFile, {
        internalKey,
        fileId: root.fileId as Id<"files">,
        content: ROOT_FILES.find((file) => file.name === root.name)!.content,
      });
    }
    const srcId = await system.mutation(api.system.createFolder, {
      internalKey,
      projectId,
      name: "src",
    });
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
        { name: "App.jsx", content: app("Before edit") },
      ],
    });
    const appId = created.find((file) => file.name === "App.jsx")!.fileId as Id<"files">;

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("tab", { name: "Preview" }).click();

    const preview = page.frameLocator('iframe[title="Preview"]');
    await expect(preview.getByRole("heading", { name: "Before edit" })).toBeVisible({
      timeout: 240_000,
    });
    // Let the post-boot file sync settle, then mark the page so a reload would show.
    await page.waitForTimeout(5_000);
    const frame = page.frame({ url: /e2b\.app/ })!;
    await frame.evaluate(() => ((window as { hmrMarker?: boolean }).hmrMarker = true));

    // The agent writes files through this same mutation.
    await system.mutation(api.system.updateFile, {
      internalKey,
      fileId: appId,
      content: app("After edit"),
    });

    // 1s sync debounce + the PATCH round trip to E2B (seconds under `next dev`)
    // + Vite's hot update. Without the fix the edit never arrives at all.
    await expect(preview.getByRole("heading", { name: "After edit" })).toBeVisible({
      timeout: 20_000,
    });
    expect(await frame.evaluate(() => (window as { hmrMarker?: boolean }).hmrMarker)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
});
