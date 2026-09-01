import { afterEach, describe, expect, it, vi } from "vitest";

import { getMessageProcessorBackend } from "./message-processor";

/**
 * Inngest is the primary backend and Vercel Workflow is its fallback. These
 * tests pin the routing rules, in particular that an unusable Workflow
 * selection degrades to Inngest rather than accepting work it cannot process.
 *
 * The two dispatch clients are mocked because both instantiate SDK clients at
 * module evaluation time (`workflow/client.ts` requires
 * `NEXT_PUBLIC_CONVEX_URL`). Backend *selection* is pure and worth testing on
 * its own; dispatch is not under test here.
 */

vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn() },
}));

vi.mock("@/features/conversations/workflow/client", () => ({
  startProcessMessageWorkflow: vi.fn(),
  cancelProcessMessageWorkflowByMessageId: vi.fn(),
}));

const VERTEX_ENV = [
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
] as const;

function stubVertexConfigured() {
  vi.stubEnv("GOOGLE_VERTEX_PROJECT", "test-project");
  vi.stubEnv("GOOGLE_CLIENT_EMAIL", "svc@test-project.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n");
}

function stubVertexMissing() {
  for (const key of VERTEX_ENV) {
    vi.stubEnv(key, "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getMessageProcessorBackend", () => {
  it("defaults to inngest when MESSAGE_PROCESSOR is unset", () => {
    vi.stubEnv("MESSAGE_PROCESSOR", "");
    expect(getMessageProcessorBackend()).toBe("inngest");
  });

  it("returns inngest when explicitly set to inngest", () => {
    vi.stubEnv("MESSAGE_PROCESSOR", "inngest");
    expect(getMessageProcessorBackend()).toBe("inngest");
  });

  it("ignores unrecognised values and stays on the primary backend", () => {
    vi.stubEnv("MESSAGE_PROCESSOR", "temporal");
    expect(getMessageProcessorBackend()).toBe("inngest");
  });

  it("tolerates casing and surrounding whitespace", () => {
    stubVertexConfigured();
    vi.stubEnv("MESSAGE_PROCESSOR", "  WORKFLOW ");
    expect(getMessageProcessorBackend()).toBe("workflow");
  });

  it("routes to workflow when selected and Vertex is configured", () => {
    stubVertexConfigured();
    vi.stubEnv("MESSAGE_PROCESSOR", "workflow");
    expect(getMessageProcessorBackend()).toBe("workflow");
  });

  it("falls back to inngest when workflow is selected but Vertex is missing", () => {
    // A fallback that cannot run is worse than no fallback: the failure would
    // only surface once the primary backend was already down.
    stubVertexMissing();
    vi.stubEnv("MESSAGE_PROCESSOR", "workflow");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getMessageProcessorBackend()).toBe("inngest");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/Falling back to the Inngest backend/);
  });

  it("falls back when Vertex is only partially configured", () => {
    // A half-configured provider is just as unusable as an absent one.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("MESSAGE_PROCESSOR", "workflow");

    for (const missing of VERTEX_ENV) {
      stubVertexConfigured();
      vi.stubEnv(missing, "");
      expect(getMessageProcessorBackend()).toBe("inngest");
    }
  });
});
