import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import type { StarterTemplate } from "./templates";

export type SeedFile = { path: string; content: string };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const appTsx = (template: StarterTemplate) => `import { Sparkles } from "lucide-react";
import { Route, Routes } from "react-router-dom";

function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-white p-6 text-center text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sparkles className="size-8 text-indigo-500" />
      <h1 className="text-3xl font-semibold tracking-tight">${template.title}</h1>
      <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
        ${template.description}
      </p>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
`;

/**
 * The starting point every template's agent run builds on: the same starter
 * `scaffoldViteApp` writes and the agent's system prompt describes (#328),
 * named after the template, with a placeholder page showing its title.
 */
export const getTemplateSeedFiles = (template: StarterTemplate): SeedFile[] =>
  VITE_REACT_STARTER.map(({ path, content }) => {
    if (path === "package.json") {
      return { path, content: json({ ...JSON.parse(content), name: template.id }) };
    }
    if (path === "index.html") {
      const title = `<title>${template.title}</title>`;
      return { path, content: content.replace("<title>App</title>", title) };
    }
    if (path === "src/App.tsx") return { path, content: appTsx(template) };
    return { path, content };
  });

/**
 * Splits seed files into the folders to create (parents first) and the files
 * to create in each folder ("" is the project root).
 */
export const planSeedTree = (files: SeedFile[]) => {
  const folders = new Set<string>();
  const filesByFolder = new Map<string, { name: string; content: string }[]>();

  for (const { path, content } of files) {
    const parts = path.split("/");
    const name = parts.pop()!;
    for (let depth = 1; depth <= parts.length; depth++) {
      folders.add(parts.slice(0, depth).join("/"));
    }
    const folder = parts.join("/");
    filesByFolder.set(folder, [...(filesByFolder.get(folder) ?? []), { name, content }]);
  }

  const sortedFolders = [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );

  return { folders: sortedFolders, filesByFolder };
};
