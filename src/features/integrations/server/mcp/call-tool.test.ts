import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock("./discover-tools", () => ({
  openMcpClient: async () => ({ client: { callTool: mocks.callTool, close: async () => {} } }),
}));

import { callMcpTool } from "./call-tool";
import type { PendingEnvRef } from "./env-refs";
import { REDACTION_PLACEHOLDER } from "./redact";
import type { ResolvedMcpServer } from "./resolve-servers";

const CANARY = "CANARY_SECRET_123";
// Secret-shaped so redaction catches it; assembled so the source holds no credential shape.
const SECRET = ["sb", "_secret_", CANARY, "_padding"].join("");

const server = { providerId: "supabase", displayName: "Supabase" } as ResolvedMcpServer;
const call = (storeEnvRefs?: (refs: readonly PendingEnvRef[]) => Promise<void>) =>
  callMcpTool({ server, toolName: "get_keys", args: {}, knownSecrets: [], storeEnvRefs });

let logs: string[];

beforeEach(() => {
  mocks.callTool.mockResolvedValue({ content: [{ type: "text", text: `key: ${SECRET}` }] });
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logs.push(JSON.stringify(args)));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callMcpTool env refs", () => {
  it("hands the model a ref, never the value, and stores the value for this ref only", async () => {
    const stored: PendingEnvRef[] = [];
    const outcome = await call(async (refs) => void stored.push(...refs));

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ value: SECRET, rule: "supabase-secret", visibility: "secret" });
    expect(outcome.text).toBe(`key: [env-ref:${stored[0].refId} secret]`);
    // The whole outcome is what the step returns and the transcript and audit draw on.
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("falls back to the placeholder when refs cannot be stored", async () => {
    const outcome = await call(async () => {
      throw new Error(`write failed for ${SECRET}`);
    });

    expect(outcome.text).toBe(`key: ${REDACTION_PLACEHOLDER}`);
    expect(outcome.text).not.toContain("env-ref");
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("keeps the placeholder when no store is given", async () => {
    expect((await call()).text).toBe(`key: ${REDACTION_PLACEHOLDER}`);
  });
});
