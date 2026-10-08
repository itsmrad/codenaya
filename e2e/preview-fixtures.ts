import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { userConvexClient } from "./convex-client";

export const hasPreviewFixtureEnv = () =>
  Boolean(process.env.CODENAYA_CONVEX_INTERNAL_KEY && process.env.NEXT_PUBLIC_CONVEX_URL);

/** Reuses (or creates) the e2e user's fixture project; the preview needs a file to boot. */
export const seedPreviewProject = async (page: Page, name: string) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const user = await userConvexClient(page);
  const existing = (await user.query(api.projects.get, {})).find(
    (project) => project.name === name,
  );
  const projectId = existing?._id ?? (await user.mutation(api.projects.create, { name }));

  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await system.mutation(api.system.cleanup, { internalKey, projectId });
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
