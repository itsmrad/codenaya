import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { mutation: mocks.mutation },
}));

import { resetSecretSealer } from "@/features/integrations/server/crypto";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { createSetEnvVarTool } from "./set-env-var";

// Runs the step body inline, so a throw inside step.run propagates like it
// would to Inngest (which retries the step).
const step = { run: vi.fn(async (_id: string, fn: () => unknown) => fn()) };
const ctx = { step } as never;

const setEnvVar = (key: string, value = "s3cret-value") =>
  createSetEnvVarTool({
    projectId: "project_a" as Id<"projects">,
    ownerId: "user_a",
    internalKey: "key",
  }).handler({ key, value }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  resetSecretSealer();
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretSealer();
});

describe("setEnvVar tool", () => {
  it("returns a config error for a secret without a KEK, without starting a step", async () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", "");

    const result = await setEnvVar("DATABASE_URL");

    expect(result).toMatch(/^Error storing DATABASE_URL: CODENAYA_LOCAL_KEK/);
    // No step means Inngest has nothing to retry.
    expect(step.run).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("stores a public variable without a KEK", async () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", "");

    expect(await setEnvVar("VITE_API_URL", "https://api.example.com")).toMatch(
      /^Stored public variable VITE_API_URL/,
    );
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("keeps transient failures inside the step so Inngest can retry them", async () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
    mocks.mutation.mockRejectedValue(new Error("fetch failed"));

    expect(await setEnvVar("DATABASE_URL")).toMatch(/fetch failed/);
    expect(step.run).toHaveBeenCalledTimes(1);
  });
});
