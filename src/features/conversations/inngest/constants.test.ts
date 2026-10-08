import { describe, expect, it } from "vitest";

import { CODING_AGENT_SYSTEM_PROMPT } from "./constants";

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
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('"vite": "^6.0.0"');
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('"@vitejs/plugin-react": "^4.0.0"');
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      'resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }',
    );
  });

  it("starts new Vite apps from the scaffold and checks config references", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("For a NEW Vite + React app, call scaffoldViteApp FIRST");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain(
      'each tsconfig "references" and "extends" path, and the index.html entry script',
    );
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("keep every package it already lists");
  });
});
