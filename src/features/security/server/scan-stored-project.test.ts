import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("@/features/integrations/server/env/resolve-env", () => ({
  resolveProjectEnv: async () => ({ publicEntries: [], secretEntries: [] }),
}));

import { scanStoredProject } from "./scan-stored-project";

// Built from parts so the repo itself holds no scannable key literals.
const GITHUB = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4"}`;

const setProject = (files: { name: string; content: string }[], instructions?: string) =>
  mocks.query.mockImplementation(async (ref) => {
    switch (getFunctionName(ref)) {
      case "system:getProjectFilesWithUrls":
        return files.map((file, index) => ({ _id: `f${index}`, type: "file", ...file }));
      case "system:getProjectById":
        return { instructions };
      default:
        return [];
    }
  });

describe("scanStoredProject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags a credential in the instructions exactly like one in a file", async () => {
    setProject([{ name: "notes.txt", content: `token: "${GITHUB}"` }], `Use this:\ntoken: "${GITHUB}"`);

    const findings = await scanStoredProject("key", "p1" as never);

    expect(findings.map(({ file, line, rule }) => ({ file, line, rule }))).toEqual([
      { file: "notes.txt", line: 1, rule: "github" },
      { file: "AGENTS.md", line: 2, rule: "github" },
    ]);
  });

  it("passes normal instructions", async () => {
    setProject([{ name: "README.md", content: "# hi" }], "Keep the brand green.");
    expect(await scanStoredProject("key", "p1" as never)).toEqual([]);
  });

  it("does not scan instructions that are not exported (own AGENTS.md wins)", async () => {
    setProject([{ name: "AGENTS.md", content: "mine" }], `token: "${GITHUB}"`);
    expect(await scanStoredProject("key", "p1" as never)).toEqual([]);
  });
});
