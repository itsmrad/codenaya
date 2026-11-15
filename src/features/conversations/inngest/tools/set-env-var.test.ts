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

  it("refuses a known secret format under a public prefix, without starting a step", async () => {
    const result = await setEnvVar("NEXT_PUBLIC_STRIPE_KEY", ["sk", "_live_", "0123456789abcdefghij"].join(""));

    expect(result).toMatch(/^Error: not stored\. .*\(stripe\)/);
    expect(result).not.toContain("0123456789abcdefghij");
    expect(step.run).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoiYW5vbiJ9", "abcdefghijklmnop"].join(".")],
    ["VITE_SUPABASE_PUBLISHABLE_KEY", ["sb", "_publishable_", "0123456789abcdefghij"].join("")],
    ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ["pk", "_test_", btoa("example.clerk.accounts.dev$")].join("")],
    ["VITE_STRIPE_KEY", ["pk", "_live_", "0123456789abcdefghij"].join("")],
    ["NEXT_PUBLIC_SENTRY_DSN", "https://abc123@o0.ingest.sentry.io/0"],
  ])("stores public-by-design %s", async (key, value) => {
    expect(await setEnvVar(key, value)).toMatch(/^Stored public variable /);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key, value }));
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("tells the model to read env vars per framework and never from browser code (#330)", async () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
    mocks.mutation.mockResolvedValue(null);

    const publicResult = await setEnvVar(
      "VITE_API_URL",
      "https://api.example.com",
    );
    expect(publicResult).toContain(
      "import.meta.env.VITE_API_URL in a Vite app",
    );

    const secretResult = await setEnvVar("STRIPE_SECRET_KEY");
    expect(secretResult).toMatch(/^Stored secret STRIPE_SECRET_KEY/);
    expect(secretResult).toContain("Never read it in browser code");
    expect(secretResult).not.toContain("import.meta.env");
  });

  it("keeps transient failures inside the step so Inngest can retry them", async () => {
    vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
    mocks.mutation.mockRejectedValue(new Error("fetch failed"));

    expect(await setEnvVar("DATABASE_URL")).toMatch(/fetch failed/);
    expect(step.run).toHaveBeenCalledTimes(1);
  });

  it("returns a readable error for invalid args instead of throwing (#616)", async () => {
    const tool = createSetEnvVarTool({
      projectId: "project_a" as Id<"projects">,
      ownerId: "user_a",
      internalKey: "key",
    });

    const result = await tool.handler({ key: null, value: "x" } as never, ctx);

    expect(result).toMatch(/^Error: /);
    expect(step.run).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
