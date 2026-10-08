/**
 * The known-good Vite + React + TypeScript + Tailwind + shadcn starter the
 * agent builds on (#190). Hand-written scaffolds kept booting into a Vite
 * error overlay: a missing "@" alias, or a tsconfig.json that references a
 * tsconfig.app.json nobody wrote. Every file here boots in the E2B preview
 * as-is; the agent extends it instead of reinventing the config.
 */

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const PACKAGE_JSON = json({
  name: "app",
  private: true,
  version: "0.0.0",
  type: "module",
  scripts: {
    dev: "vite",
    build: "vite build",
    preview: "vite preview",
    lint: "eslint src",
  },
  dependencies: {
    "@fontsource/inter": "^5.1.0",
    "class-variance-authority": "^0.7.1",
    clsx: "^2.1.1",
    "lucide-react": "^0.468.0",
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwind-merge": "^2.6.0",
    "tailwindcss-animate": "^1.0.7",
  },
  devDependencies: {
    "@types/node": "^22.10.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    autoprefixer: "^10.4.20",
    postcss: "^8.4.49",
    tailwindcss: "^3.4.17",
    typescript: "~5.6.3",
    vite: "^6.0.0",
  },
});

const VITE_CONFIG = `import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
`;

const TSCONFIG = json({
  files: [],
  references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
  compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
});

const TSCONFIG_APP = json({
  compilerOptions: {
    target: "ES2020",
    useDefineForClassFields: true,
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    skipLibCheck: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: "force",
    noEmit: true,
    jsx: "react-jsx",
    strict: true,
    noFallthroughCasesInSwitch: true,
    baseUrl: ".",
    paths: { "@/*": ["./src/*"] },
  },
  include: ["src"],
});

const TSCONFIG_NODE = json({
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2023"],
    module: "ESNext",
    skipLibCheck: true,
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: "force",
    noEmit: true,
    strict: true,
  },
  include: ["vite.config.ts", "tailwind.config.ts"],
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const TAILWIND_CONFIG = `import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const color = (name: string) => ({
  DEFAULT: \`hsl(var(--\${name}))\`,
  foreground: \`hsl(var(--\${name}-foreground))\`,
});

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: color("primary"),
        secondary: color("secondary"),
        destructive: color("destructive"),
        muted: color("muted"),
        accent: color("accent"),
        popover: color("popover"),
        card: color("card"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
`;

const COMPONENTS_JSON = json({
  $schema: "https://ui.shadcn.com/schema.json",
  style: "default",
  rsc: false,
  tsx: true,
  tailwind: {
    config: "tailwind.config.ts",
    css: "src/index.css",
    baseColor: "slate",
    cssVariables: true,
  },
  aliases: { components: "@/components", utils: "@/lib/utils" },
});

const INDEX_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }

  * {
    @apply border-border;
  }

  body {
    @apply bg-background text-foreground font-sans antialiased;
  }
}
`;

const MAIN_TSX = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./index.css";

import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const APP_TSX = `export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight">App</h1>
    </main>
  );
}
`;

const UTILS_TS = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

/** Project-relative paths and contents, folders implied by the paths. */
export const VITE_REACT_STARTER: ReadonlyArray<{ path: string; content: string }> = [
  { path: "package.json", content: PACKAGE_JSON },
  { path: "vite.config.ts", content: VITE_CONFIG },
  { path: "tsconfig.json", content: TSCONFIG },
  { path: "tsconfig.app.json", content: TSCONFIG_APP },
  { path: "tsconfig.node.json", content: TSCONFIG_NODE },
  { path: "index.html", content: INDEX_HTML },
  { path: "postcss.config.js", content: POSTCSS_CONFIG },
  { path: "tailwind.config.ts", content: TAILWIND_CONFIG },
  { path: "components.json", content: COMPONENTS_JSON },
  { path: "src/vite-env.d.ts", content: '/// <reference types="vite/client" />\n' },
  { path: "src/index.css", content: INDEX_CSS },
  { path: "src/main.tsx", content: MAIN_TSX },
  { path: "src/App.tsx", content: APP_TSX },
  { path: "src/lib/utils.ts", content: UTILS_TS },
];
