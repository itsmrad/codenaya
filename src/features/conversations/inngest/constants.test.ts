import { describe, expect, it } from "vitest";

import { CODING_AGENT_SYSTEM_PROMPT } from "./constants";
import { KNOWN_GOOD_VERSIONS } from "./known-good-versions";

describe("coding agent integration instructions", () => {
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
    expect(KNOWN_GOOD_VERSIONS.vite).toMatch(/^\^6\./);
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
