import { pinnedVersions } from "./known-good-versions";
import { INDEX_CSS, UTILS_TS } from "./vite-starter";
import { VITE_STARTER_UI } from "./vite-starter-ui";

/** Only explicit framework names select Next; ordinary phrases like "next step" do not. */
export const wantsNextJs = (prompt: string): boolean =>
  /\b(?:next(?:\.js|\s+js|js)|next\s+15\s+app|app\s+router)\b/i.test(prompt);

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** App Router starter; shared shadcn components and design tokens match the Vite starter. */
export const NEXT_APP_STARTER: ReadonlyArray<{ path: string; content: string }> = [
  {
    path: "package.json",
    content: json({
      name: "app",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: pinnedVersions([
        "next",
        "react",
        "react-dom",
        "@hookform/resolvers",
        "@radix-ui/react-avatar",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-label",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slot",
        "@radix-ui/react-tabs",
        "@radix-ui/react-tooltip",
        "sonner",
        "class-variance-authority",
        "clsx",
        "lucide-react",
        "react-hook-form",
        "tailwind-merge",
        "zod",
      ]),
      devDependencies: pinnedVersions([
        "@tailwindcss/postcss",
        "@types/node",
        "@types/react",
        "@types/react-dom",
        "tailwindcss",
        "tw-animate-css",
        "postcss",
        "typescript",
      ]),
    }),
  },
  {
    path: "next.config.ts",
    content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`,
  },
  {
    path: "tsconfig.json",
    content: json({
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
  },
  {
    path: "next-env.d.ts",
    content: '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  },
  {
    path: "postcss.config.mjs",
    content: 'export default { plugins: { "@tailwindcss/postcss": {} } };\n',
  },
  {
    path: "components.json",
    content: json({
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      rsc: true,
      tsx: true,
      tailwind: { config: "", css: "src/app/globals.css", baseColor: "slate", cssVariables: true, prefix: "" },
      iconLibrary: "lucide",
      aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
    }),
  },
  {
    path: "src/app/layout.tsx",
    content: `import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = { title: "App", description: "Built with Codenaya" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
`,
  },
  {
    path: "src/app/page.tsx",
    content: `export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-3xl font-semibold tracking-tight">App</h1>
    </main>
  );
}
`,
  },
  { path: "src/app/globals.css", content: INDEX_CSS },
  {
    path: "src/app/error.tsx",
    content: `"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <button type="button" onClick={reset} className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground">
        Try again
      </button>
    </main>
  );
}
`,
  },
  { path: "src/lib/utils.ts", content: UTILS_TS },
  ...VITE_STARTER_UI,
];
