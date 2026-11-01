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

  it("keeps edits minimal and the performance rules out of the base prompt", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("make the smallest correct change");
    expect(CODING_AGENT_SYSTEM_PROMPT).not.toContain("react_performance_rules");
  });

  it("trusts the installed versions and keeps third-party API calls off the browser", () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("never use APIs or syntax from a newer major");
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain("usually fails on CORS");
  });
});
