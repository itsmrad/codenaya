import { describe, expect, it } from "vitest";

import {
  CODING_AGENT_SYSTEM_PROMPT,
  STARTER_IN_PLACE_NOTE,
  SWARM_ORCHESTRATOR_NOTE,
  SWARM_SUBORCH_NOTE,
  SWARM_WORKER_NOTE,
  TANSTACK_START_NOTE,
} from "./constants";
import { KNOWN_GOOD_VERSIONS } from "./known-good-versions";

describe("coding agent summary format (#256)", () => {
  const format = CODING_AGENT_SYSTEM_PROMPT.slice(CODING_AGENT_SYSTEM_PROMPT.indexOf("<response_format>"));

  it("replies like a senior dev: built, placeholders, next steps, not a tree or setup steps", () => {
    expect(format).toContain("When you reply to the user");
    for (const section of ["**What I built**", "**Placeholders to replace**", "**Recommended next steps**"]) {
      expect(format).toContain(section);
    }
    expect(format).toContain("<suggestions>");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("npm install");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("npm run dev");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/File structure|real tree of the files/);
  });

  it("names the chip action tags the chat runs", () => {
    for (const tag of ["[connect:supabase]", "[publish]", "[env-vars]"]) expect(format).toContain(tag);
  });

  it("keeps swarm workers and sub-orchestrators out of the user voice", () => {
    for (const note of [SWARM_WORKER_NOTE, SWARM_SUBORCH_NOTE]) {
      expect(note).toContain("[swarm-worker]");
      expect(note).toContain("NEEDS: section for the orchestrator");
      expect(note).toContain("not the user: no next steps, suggestions or action chips");
    }
    expect(SWARM_SUBORCH_NOTE).toContain("[swarm-worker] [swarm-suborchestrator]");
  });
});

describe("coding agent integration instructions", () => {
  it("imports shipped shadcn components and uses Sonner (#294)", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Import existing components; do not rewrite them");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("button, card, input, label, textarea, badge, dialog, dropdown-menu, select, tabs, sheet, separator, skeleton, tooltip, avatar and sonner");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Add other components and their dependencies only when needed");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('import { toast } from "sonner"');
    expect(STARTER_IN_PLACE_NOTE).toContain("Import these components; do not rewrite them");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/useToast\(\)|write them all|ALL shadcn component source files|Write the actual component source/);
  });

  it("reuses Next.js starter components and keeps a single Toaster in the root layout", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("The Vite and Next.js starters already include components.json");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Vite in src/main.tsx, Next.js in src/app/layout.tsx");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("already installed for the Vite and Next.js starters' shipped components");
  });

  it("keeps Next.js API secrets in authenticated server handlers or actions", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("route handlers (src/app/api/**/route.ts) or server actions");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("server-only env vars without a NEXT_PUBLIC_ prefix");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("authenticate and authorize each request");
  });

  it("describes both swarm foundations and leaves route content to workers or integration", () => {
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("For Vite, routing is src/App.tsx");
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("routing is the file system");
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("set up src/app/layout.tsx, and new routes use");
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("src/app/<route>/page.tsx stubs (export default function Page(){return null})");
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("Existing files are never stubbed");
    expect(SWARM_ORCHESTRATOR_NOTE).toContain("delegate home content as a component and wire it in during integration");
  });

  it("treats runtime MCP state as authoritative over generated project files", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      'Integration availability comes only from the runtime "Connected integrations" section',
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toMatch(
      /do not inspect workspace files\s+to decide whether the integration exists/,
    );
  });

  it("keeps MCP credentials outside model context and project files", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "NEVER ask the user to paste an MCP API key",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Integrations → Add a connection",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "MCP authentication is injected into the server-side transport automatically",
    );
  });

  it("keeps the TanStack Start block out of the static prompt", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/<tanstack_start>|routeTree\.gen|createServerFn/);
    expect(TANSTACK_START_NOTE).toContain("Never write or edit src/routeTree.gen.ts");
    expect(TANSTACK_START_NOTE).toContain(".validator(schema)");
  });

  it("requires internal links to point at routes the app defines", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Every internal link (<Link to>, <a href=\"/...\">, navigate()) must point to a route the app defines",
    );
  });

  it("requires remote provisioning to be applied and verified", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Creating or editing a migration file does not change the remote database",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "verify it with a read tool before claiming success",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "never describe an unapplied migration as a completed fix",
    );
  });

  it("pins Vite scaffolds to a major the preview sandbox's Node can run, with the @ alias", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(`"vite": "${KNOWN_GOOD_VERSIONS.vite}"`);
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      `"@vitejs/plugin-react": "${KNOWN_GOOD_VERSIONS["@vitejs/plugin-react"]}"`,
    );
    expect(KNOWN_GOOD_VERSIONS.vite).toMatch(/^\^8\./);
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("New apps use Vite 8 with @vitejs/plugin-react 6");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("Never use Vite 7+");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      'resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }',
    );
  });

  it("reads Vite env vars from import.meta.env and keeps secrets out of client code (#330)", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "In Vite apps read env vars with import.meta.env.VITE_*. NEVER use process.env in Vite browser code",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Secrets never get a VITE_ or NEXT_PUBLIC_ prefix and never go in client code",
    );
  });

  it("starts new Vite apps from the scaffold and checks config references", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("For a NEW Vite + React app, call scaffoldViteApp FIRST");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      'each tsconfig "references" and "extends" path, and the index.html entry script',
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("keep every package it already lists");
    // #335: the starter mounts the router and an error boundary.
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "The router and an error boundary are already mounted in src/main.tsx; add routes in src/App.tsx. Don't add another <BrowserRouter>.",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "If you edit src/main.tsx, keep its <ErrorBoundary> and <BrowserRouter>",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Vite: scaffoldViteApp already wrote src/main.tsx");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("src/App.tsx / src/main.tsx");
  });

  it("describes the React 19 + Tailwind v4 starter stack (#332)", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("STYLING: Tailwind CSS v4 (always)");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("ROUTING (Vite): react-router-dom v7");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("It has no brand icons");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("@theme inline");
    for (const stale of [
      "React 18",
      "Tailwind CSS 3",
      "Tailwind CSS v3",
      "react-router-dom v6",
      "tailwindcss-animate",
      "postcss.config.js",
      "autoprefixer",
      "@tailwind base",
    ]) {
      expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain(stale);
    }
    // tailwind.config.ts is only named to say new projects have none and v3 projects keep v3.
    expect(CODING_AGENT_SYSTEM_PROMPT.match(/tailwind\.config\.ts/g)).toHaveLength(2);
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("there is no tailwind.config.ts");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "A project with tailwind.config.ts or @tailwind directives is Tailwind v3 and keeps v3 syntax",
    );
  });

  it("lists every known-good version, so the prompt matches the starter and write checks (#331)", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Stack versions (use exactly these ranges");
    for (const [name, range] of Object.entries(KNOWN_GOOD_VERSIONS)) {
      expect(CODING_AGENT_SYSTEM_PROMPT).toContain(`"${name}": "${range}"`);
    }
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain('"@vitejs/plugin-react": "^4.0.0"');
  });
});

describe("coding agent prompt consistency (#293)", () => {
  it("has one narration rule: a short sentence with each tool call", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Every time you call tools, include ONE short sentence of plain text",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/Execute silently|NEVER use phrases like "Let me/);
  });

  it("defaults to Vite + React and uses Next.js only on request", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      "Vite + React + TypeScript, unless the user explicitly asks for Next.js",
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("Full-stack / SSR / data-fetching / auth apps");
  });

  it("does not spend tool calls re-listing or re-reading files it just wrote", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("don't re-list or re-read files you just wrote");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/call listFiles again|Re-read critical files/);
  });

  it("addresses files by path from the prompt's file list (#292)", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('Read the workspace structure from the "Project files" section');
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Write files with writeFiles by path");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/Call listFiles to inspect|Create ALL folders first|createFolder|createFiles|folder IDs/);
  });

  it("keeps edits minimal and the performance rules out of the base prompt", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("make the smallest correct change");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("react_performance_rules");
  });

  it("trusts the installed versions and keeps third-party API calls off the browser", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("never use APIs or syntax from a newer major");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("usually fails on CORS");
  });

  it("keeps generated content visible by default and respects reduced motion", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Content is visible by default");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("Never animate above-the-fold content");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('reducedMotion="user"');
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("reveals may only translate");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/initial=\{\{\s*opacity:\s*0/);
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toMatch(/hidden:\s*\{[^}]*opacity:\s*0/);
  });
});
