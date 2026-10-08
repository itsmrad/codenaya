import type { StarterTemplate } from "./templates";

export type SeedFile = { path: string; content: string };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The starting point every template's agent run builds on: a minimal
 * Vite + React + TypeScript + Tailwind v3 app that installs and runs with
 * `npm run dev` on the codenaya-node22 preview, laid out the way the agent's
 * system prompt expects.
 */
export const getTemplateSeedFiles = (template: StarterTemplate): SeedFile[] => [
  {
    path: "package.json",
    content: json({
      name: template.id,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc --noEmit && vite build",
        preview: "vite preview",
      },
      dependencies: {
        "lucide-react": "^0.468.0",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        "@types/react": "^18.3.12",
        "@types/react-dom": "^18.3.1",
        "@vitejs/plugin-react": "^4.3.4",
        autoprefixer: "^10.4.20",
        postcss: "^8.4.49",
        tailwindcss: "^3.4.17",
        typescript: "~5.6.3",
        vite: "^6.0.7",
      },
    }),
  },
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${template.title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: "vite.config.ts",
    content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
  },
  {
    path: "tsconfig.json",
    content: json({
      compilerOptions: {
        target: "ES2020",
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        isolatedModules: true,
        skipLibCheck: true,
        types: ["vite/client"],
      },
      include: ["src"],
    }),
  },
  {
    path: "postcss.config.js",
    content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
  },
  {
    path: "tailwind.config.ts",
    content: `import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
`,
  },
  {
    path: "src/index.css",
    content: `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
  },
  {
    path: "src/main.tsx",
    content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  },
  {
    path: "src/App.tsx",
    content: `import { Sparkles } from "lucide-react";

export default function App() {
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
`,
  },
];

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
