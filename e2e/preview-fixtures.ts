import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { userConvexClient } from "./convex-client";

export const hasPreviewFixtureEnv = () =>
  Boolean(process.env.CODENAYA_CONVEX_INTERNAL_KEY && process.env.NEXT_PUBLIC_CONVEX_URL);

/** Longer than any test, so a project this young may still be in use by a parallel test. */
const STALE_PROJECT_MS = 60 * 60_000;

/**
 * A fresh fixture project for the e2e user; the preview needs a file to boot.
 * Never reused: a killed run leaves its messages behind (a "processing" run
 * stays active), and a parallel test of the same name would share its files.
 * Removes earlier runs' projects of that name once they are stale.
 */
export const seedPreviewProject = async (page: Page, name: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const user = await userConvexClient(page);
  for (const project of await user.query(api.projects.get, {})) {
    if (project.name === name && project._creationTime < Date.now() - STALE_PROJECT_MS) {
      await user.mutation(api.projects.remove, { id: project._id }).catch(() => {});
    }
  }
  const projectId = await user.mutation(api.projects.create, { name });

  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await system.mutation(api.system.createFile, {
    internalKey,
    projectId,
    name: "index.html",
    content: "<h1>Hello</h1>\n",
  });

  return projectId;
};

/** Writes the smallest Vite + React app (with `src/App.jsx` from `appSource`) into the project. */
export const seedViteApp = async (
  projectId: Id<"projects">,
  {
    appSource,
    devDependencies,
  }: { appSource: string; devDependencies: Record<string, string> },
) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const rootFiles = [
    {
      name: "package.json",
      content: JSON.stringify({
        name: "vite-e2e",
        private: true,
        type: "module",
        scripts: { dev: "vite" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies,
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
  const roots = await system.mutation(api.system.createFiles, {
    internalKey,
    projectId,
    files: rootFiles,
  });
  // seedPreviewProject already wrote an index.html; replace it with the Vite entry.
  for (const root of roots.filter((file) => file.error)) {
    await system.mutation(api.system.updateFile, {
      internalKey,
      projectId,
      fileId: root.fileId as Id<"files">,
      content: rootFiles.find((file) => file.name === root.name)!.content,
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
      { name: "App.jsx", content: appSource },
    ],
  });

  return created.find((file) => file.name === "App.jsx")!.fileId as Id<"files">;
};
