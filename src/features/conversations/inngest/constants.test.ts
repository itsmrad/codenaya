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
});
