import { INDEX_CSS, UTILS_TS } from "./vite-starter";
import { VITE_STARTER_UI } from "./vite-starter-ui";

/** Only explicit framework names select Next; ordinary phrases like "next step" do not. */
export const wantsNextJs = (prompt: string): boolean =>
  /\b(?:next(?:\.js|\s+js|js)|next\s+1[56]\s+app|app\s+router)\b/i.test(prompt);

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
      // Exact versions, newest within the known-good majors (npm view, 2026-11-15): a
      // range resolves today's newest, which an older cached packument may lack (ETARGET).
      dependencies: {
        next: "16.4.6",
        react: "19.3.1",
        "react-dom": "19.3.1",
        "@hookform/resolvers": "7.0.6",
        "@radix-ui/react-avatar": "1.3.1",
        "@radix-ui/react-dialog": "1.3.1",
        "@radix-ui/react-dropdown-menu": "2.2.1",
        "@radix-ui/react-label": "2.1.17",
        "@radix-ui/react-select": "2.4.1",
        "@radix-ui/react-separator": "1.2.0",
        "@radix-ui/react-slot": "1.5.0",
        "@radix-ui/react-tabs": "1.2.1",
        "@radix-ui/react-tooltip": "1.4.1",
        sonner: "2.0.8",
        "class-variance-authority": "0.7.1",
        clsx: "2.1.1",
        "lucide-react": "1.73.0",
        "react-hook-form": "7.92.0",
        "tailwind-merge": "3.7.0",
        zod: "4.6.7",
      },
      devDependencies: {
        "@tailwindcss/postcss": "4.3.5",
        "@types/node": "22.20.5",
        "@types/react": "19.3.0",
        "@types/react-dom": "19.3.0",
        tailwindcss: "4.3.5",
        "tw-animate-css": "1.4.0",
        postcss: "8.5.33",
        typescript: "5.9.3",
      },
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
        jsx: "react-jsx",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
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
