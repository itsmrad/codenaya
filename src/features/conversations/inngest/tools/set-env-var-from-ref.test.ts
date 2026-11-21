import { randomBytes } from "node:crypto";

import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), killOutdatedPreviews: vi.fn() }));

vi.mock("@/lib/convex-client", () => ({ convex: { mutation: mocks.mutation } }));
vi.mock("@/features/sandbox-preview/server/runtime-fence", () => ({ killOutdatedPreviews: mocks.killOutdatedPreviews }));

import {
  getSecretSealer,
  resetSecretSealer,
  secretContext,
  type SealedSecret,
} from "@/features/integrations/server/crypto";
import { createEnvRefMinter, type EnvRefVisibility } from "@/features/integrations/server/mcp/env-refs";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { createSetEnvVarFromRefTool } from "./set-env-var-from-ref";

const CANARY = "CANARY_SECRET_123";
const projectId = "project_a" as Id<"projects">;

/** In-memory stand-in for the Convex side: refs this run holds, and the env var writes. */
let refs: Map<string, { visibility: EnvRefVisibility; sealed: SealedSecret }>;
let existingKeys: Set<string>;
let writes: Array<{ fn: string; args: Record<string, unknown> }>;
let stepReturns: unknown[];
let logs: string[];

const step = {
  run: vi.fn(async (_id: string, fn: () => Promise<unknown>) => {
    const result = await fn();
    stepReturns.push(result);
    return result;
  }),
};

const storeRef = async (value: string, visibility: EnvRefVisibility) => {
  const { toRef, refs: minted } = createEnvRefMinter();
  toRef(value, "test");
  const { refId } = minted[0];
  refs.set(refId, {
    visibility,
    sealed: await getSecretSealer().seal(value, secretContext("mcpEnvRefs", refId, "value")),
  });
  return refId;
};

const setFromRef = (params: { name: string; ref: string; overwrite?: boolean }) =>
  createSetEnvVarFromRefTool({
    projectId,
    ownerId: "user_a",
    messageId: "message_a" as Id<"messages">,
    internalKey: "key",
  }).handler(params, { step } as never);

const everythingVisible = () => JSON.stringify({ stepReturns, logs });

beforeEach(() => {
  vi.clearAllMocks();
  resetSecretSealer();
  vi.stubEnv("CODENAYA_KEK_PROVIDER", "");
  vi.stubEnv("CODENAYA_LOCAL_KEK", randomBytes(32).toString("base64"));
  refs = new Map();
  existingKeys = new Set();
  writes = [];
  stepReturns = [];
  logs = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logs.push(JSON.stringify(args)));
  }
  mocks.mutation.mockImplementation(async (fn, args) => {
    const name = getFunctionName(fn);
    if (name === "envRefs:resolveEnvRef") {
      const ref = refs.get(args.refId);
      return ref ? { visibility: ref.visibility, keyExists: existingKeys.has(args.key), ...ref.sealed } : null;
    }
    writes.push({ fn: name, args });
    existingKeys.add(args.key);
    return "env_var_id";
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSecretSealer();
});

describe("setEnvVarFromRef", () => {
  it("stores a secret ref sealed, and the value reaches no result, step return or log", async () => {
    const ref = await storeRef(CANARY, "secret");

    const result = await setFromRef({ name: "SUPABASE_SECRET_KEY", ref });

    expect(result).toBe("Set SUPABASE_SECRET_KEY (secret)");
    expect(stepReturns).toEqual([result]);
    expect(everythingVisible()).not.toContain(CANARY);

    expect(writes).toHaveLength(1);
    const { fn, args } = writes[0];
    expect(fn).toBe("system:setSecretEnvVar");
    expect(args).toMatchObject({ key: "SUPABASE_SECRET_KEY", source: "integration" });
    expect(JSON.stringify(args)).not.toContain(CANARY);
    const opened = await getSecretSealer().open(
      args as unknown as SealedSecret,
      secretContext("projectEnvVars", args.secretRef as string, "value"),
    );
    expect(opened).toBe(CANARY);
  });

  it.each(["NEXT_PUBLIC_KEY", "VITE_KEY", "PUBLIC_KEY"])("refuses a secret ref under %s", async (name) => {
    const ref = await storeRef(CANARY, "secret");

    const result = await setFromRef({ name, ref });

    expect(result).toMatch(/^Error: not stored\./);
    expect(writes).toEqual([]);
    expect(everythingVisible()).not.toContain(CANARY);
  });

  it("refuses a non-Supabase JWT with no role under a public name: it is a secret ref", async () => {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = [b64({ alg: "HS256" }), b64({ sub: "user_1", iss: "auth0" }), "signaturesignature"].join(".");
    const { toRef, refs: minted } = createEnvRefMinter();
    toRef(token, "jwt");
    expect(minted[0].visibility).toBe("secret");
    const ref = await storeRef(token, minted[0].visibility);

    expect(await setFromRef({ name: "VITE_X", ref })).toMatch(/^Error: not stored\./);
    expect(writes).toEqual([]);
  });

  it("stores a public ref under a public name through the public writer", async () => {
    const url = "https://abcdefghijklmnopqrst.supabase.co";
    const ref = await storeRef(url, "public");

    expect(await setFromRef({ name: "VITE_SUPABASE_URL", ref })).toBe("Set VITE_SUPABASE_URL (public)");
    expect(writes).toEqual([
      {
        fn: "system:setPublicEnvVarInternal",
        args: { internalKey: "key", projectId, ownerId: "user_a", key: "VITE_SUPABASE_URL", value: url },
      },
    ]);
  });

  it("refuses to overwrite without the flag, and logs an overwrite by name only", async () => {
    const ref = await storeRef(CANARY, "secret");
    existingKeys.add("API_KEY");

    expect(await setFromRef({ name: "API_KEY", ref })).toMatch(/^Error: API_KEY is already set/);
    expect(writes).toEqual([]);

    expect(await setFromRef({ name: "API_KEY", ref, overwrite: true })).toBe("Set API_KEY (secret)");
    expect(writes).toHaveLength(1);
    expect(console.info).toHaveBeenCalledWith(
      "[env-refs] overwrote env var",
      JSON.stringify({ key: "API_KEY", projectId, refId: ref }),
    );
    expect(everythingVisible()).not.toContain(CANARY);
  });

  it("fails generically for an unknown, expired or foreign ref", async () => {
    // resolveEnvRef returns null for all three; convex/envRefs.test.ts covers the binding.
    const result = await setFromRef({ name: "API_KEY", ref: "ref_00000000000000000000000000000000" });

    expect(result).toMatch(/^Error: ref .* is unknown or expired/);
    expect(writes).toEqual([]);
  });

  it("returns a generic error when a write fails, even if the error quotes the value", async () => {
    const ref = await storeRef(CANARY, "secret");
    mocks.mutation.mockImplementation(async (fn, args) => {
      if (getFunctionName(fn) === "envRefs:resolveEnvRef") {
        const stored = refs.get(args.refId)!;
        return { visibility: stored.visibility, keyExists: false, ...stored.sealed };
      }
      throw new Error(`ArgumentValidationError: Value: "${CANARY}"`);
    });

    const result = await setFromRef({ name: "API_KEY", ref });

    expect(result).toBe("Error: could not set the variable. You may retry on a later turn.");
    expect(everythingVisible()).not.toContain(CANARY);
  });

  it("stops previews still holding the old value right after a write, and not after a refusal", async () => {
    const ref = await storeRef("https://abcdefghijklmnopqrst.supabase.co", "public");
    expect(await setFromRef({ name: "VITE_SUPABASE_URL", ref })).toBe("Set VITE_SUPABASE_URL (public)");
    expect(mocks.killOutdatedPreviews).toHaveBeenCalledWith("key", projectId);

    mocks.killOutdatedPreviews.mockClear();
    const secret = await storeRef(CANARY, "secret");
    expect(await setFromRef({ name: "VITE_X", ref: secret })).toMatch(/^Error: not stored\./);
    expect(mocks.killOutdatedPreviews).not.toHaveBeenCalled();
  });

  it("rejects an invalid name before any step", async () => {
    expect(await setFromRef({ name: "not valid", ref: "ref_x" })).toMatch(/^Error: "not valid" is not a valid/);
    expect(step.run).not.toHaveBeenCalled();
  });

  it("accepts the whole [env-ref:…] token and rejects a malformed ref before any step", async () => {
    const ref = await storeRef("https://abcdefghijklmnopqrst.supabase.co", "public");

    expect(await setFromRef({ name: "VITE_SUPABASE_URL", ref: `[env-ref:${ref} public]` })).toBe(
      "Set VITE_SUPABASE_URL (public)",
    );
    vi.clearAllMocks();
    expect(await setFromRef({ name: "API_KEY", ref: "ref_x" })).toMatch(/^Error: ref must look like/);
    expect(step.run).not.toHaveBeenCalled();
  });
});
