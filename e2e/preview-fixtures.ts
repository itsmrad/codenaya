import type { Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pinnedVersions } from "../src/features/conversations/inngest/known-good-versions";
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

/** Minimal Next App Router fixture; returns page.tsx's id for live edits. */
export const seedNextApp = async (
  projectId: Id<"projects">,
  { pageSource }: { pageSource: string },
) => {
  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY!;
  const system = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await system.mutation(api.system.createFiles, {
    internalKey,
    projectId,
    files: [{
      name: "package.json",
      content: JSON.stringify({
        name: "next-e2e",
        private: true,
        scripts: { dev: "next dev", build: "next build" },
        dependencies: pinnedVersions(["next", "react", "react-dom"]),
        devDependencies: pinnedVersions([
          "typescript", "@types/node", "@types/react", "@types/react-dom",
        ]),
      }),
    }],
  });
  const srcId = await system.mutation(api.system.createFolder, {
    internalKey, projectId, name: "src",
  });
  const appId = await system.mutation(api.system.createFolder, {
    internalKey, projectId, parentId: srcId, name: "app",
  });
  const created = await system.mutation(api.system.createFiles, {
    internalKey,
    projectId,
    parentId: appId,
    files: [
      {
        name: "layout.tsx",
        content: `import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
      },
      { name: "page.tsx", content: pageSource },
    ],
  });
  const actionsId = await system.mutation(api.system.createFolder, {
    internalKey, projectId, parentId: appId, name: "actions",
  });
  await system.mutation(api.system.createFiles, {
    internalKey,
    projectId,
    parentId: actionsId,
    files: [{
      name: "page.tsx",
      content: `import { redirect } from "next/navigation";
export default async function Page({ searchParams }: {
  searchParams: Promise<{ message?: string }>;
}) {
  const { message } = await searchParams;
  async function submit(formData: FormData) {
    "use server";
    redirect("/actions?message=" + encodeURIComponent(String(formData.get("message"))));
  }
  return <main>
    <h1>Server Action form</h1>
    <p role="status">{message ? "Submitted: " + message : "No submission yet"}</p>
    <form action={submit}>
      <label>Message<input name="message" /></label>
      <button type="submit">Submit message</button>
    </form>
  </main>;
}
`,
    }],
  });
  return created.find((file) => file.name === "page.tsx")!.fileId as Id<"files">;
};
