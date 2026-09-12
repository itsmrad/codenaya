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
});
