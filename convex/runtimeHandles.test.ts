// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const INTERNAL_KEY = "test-internal-key";
const ALICE = "user_alice";
const BOB = "user_bob";
const sealed = { kekProvider: "local", kekKeyId: "k1", wrappedDek: "dek", ciphertext: "ct", iv: "iv", authTag: "tag" };

beforeEach(() => vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY));
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const t = convexTest(schema, modules);
  const projectId = await t.run((ctx) =>
    ctx.db.insert("projects", { name: "Fence", ownerId: ALICE, updatedAt: 0 }),
  );
  const alice = t.withIdentity({ subject: ALICE });
  const setSecret = (key = "API_KEY") =>
    t.mutation(api.system.setSecretEnvVar, {
      internalKey: INTERNAL_KEY, projectId, ownerId: ALICE, key, secretRef: "ref", maskedPreview: "x", source: "manual", ...sealed,
    });
  const read = () => t.query(api.runtimeHandles.getBootManifest, { internalKey: INTERNAL_KEY, projectId });
  const register = (generation: number, sandboxId = "e2b:sbx_1", replacesPreviews = true) =>
    t.mutation(api.runtimeHandles.registerRuntime, {
      internalKey: INTERNAL_KEY, projectId, ownerId: ALICE, sandboxId, generation, replacesPreviews,
    });
  const admit = (handleId: Id<"runtimeHandles">) =>
    t.mutation(api.runtimeHandles.admitRuntime, { internalKey: INTERNAL_KEY, handleId });
  const state = (handleId: Id<"runtimeHandles">) => t.run(async (ctx) => (await ctx.db.get("runtimeHandles", handleId))?.state);
  return { t, projectId, alice, setSecret, read, register, admit, state };
}

describe("runtime admission fence", () => {
  test("a project without envGeneration reads as 0 and admits a boot at 0", async () => {
    const { setSecret, read, register, admit, state, t, projectId } = await setup();
    await t.run((ctx) => ctx.db.insert("projectEnvVars", {
      projectId, ownerId: ALICE, key: "API_KEY", visibility: "secret", maskedPreview: "x", source: "manual", updatedAt: 0, ...sealed,
    }));

    const manifest = await read();
    expect(manifest).toMatchObject({ generation: 0, records: [{ key: "API_KEY" }] });
    const handleId = await register(manifest!.generation);
    expect(await admit(handleId)).toBe(true);
    expect(await state(handleId)).toBe("running");

    // An edit while it runs outdates it.
    await setSecret();
    expect(await state(handleId)).toBe("stale");
    expect((await read())!.generation).toBe(1);
  });

  test("a delete after the read and before register refuses admission", async () => {
    const { setSecret, read, alice, register, admit, state } = await setup();
    const id = await setSecret();
    const { generation } = (await read())!;

    await alice.mutation(api.envVars.deleteEnvVar, { id });
    const handleId = await register(generation);

    expect(await admit(handleId)).toBe(false);
    expect(await state(handleId)).toBe("stale");
  });

  test("a delete between register and admit marks the pending handle stale and refuses it", async () => {
    const { setSecret, read, alice, register, admit, state } = await setup();
    const id = await setSecret();
    const handleId = await register((await read())!.generation);

    await alice.mutation(api.envVars.deleteEnvVar, { id });
    expect(await state(handleId)).toBe("stale");
    expect(await admit(handleId)).toBe(false);
  });

  test.each([
    ["a public save", (s: Awaited<ReturnType<typeof setup>>) =>
      s.alice.mutation(api.envVars.setPublicEnvVar, { projectId: s.projectId, key: "VITE_URL", value: "https://example.com" })],
    ["an internal public save", (s: Awaited<ReturnType<typeof setup>>) =>
      s.t.mutation(api.system.setPublicEnvVarInternal, {
        internalKey: INTERNAL_KEY, projectId: s.projectId, ownerId: ALICE, key: "VITE_URL", value: "https://example.com",
      })],
  ])("%s outdates a running preview", async (_case, change) => {
    const s = await setup();
    await s.setSecret();
    const handleId = await s.register((await s.read())!.generation);
    expect(await s.admit(handleId)).toBe(true);

    await change(s);

    expect(await s.state(handleId)).toBe("stale");
  });

  test("a project delete during boot refuses admission and hides the manifest", async () => {
    const { setSecret, read, alice, register, admit, state, projectId } = await setup();
    await setSecret();
    const handleId = await register((await read())!.generation);

    await alice.mutation(api.projects.remove, { id: projectId });

    expect(await state(handleId)).toBe("stale");
    expect(await admit(handleId)).toBe(false);
    expect(await read()).toBeNull();
    await expect(register(1)).rejects.toThrow("Project not found");
  });

  test("an account delete outdates the owner's running previews", async () => {
    const { t, setSecret, read, register, admit, state } = await setup();
    await setSecret();
    const handleId = await register((await read())!.generation);
    expect(await admit(handleId)).toBe(true);

    await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });

    expect(await state(handleId)).toBe("stale");
  });

  test("a fresh boot replaces every earlier handle; a resume replaces only its own sandbox's", async () => {
    const { register, admit, state } = await setup();
    const first = await register(0, "e2b:sbx_a");
    await admit(first);
    const second = await register(0, "e2b:sbx_b", false);
    await admit(second);

    const resumed = await register(0, "e2b:sbx_a", false);
    expect([await state(first), await state(second)]).toEqual(["stale", "running"]);

    await register(0, "e2b:sbx_c");
    expect([await state(second), await state(resumed)]).toEqual(["stale", "stale"]);
  });

  test("admits a handle once", async () => {
    const { register, admit } = await setup();
    const handleId = await register(0);
    expect(await admit(handleId)).toBe(true);
    expect(await admit(handleId)).toBe(false);
  });

  test("only the project owner can register, and only with the internal key", async () => {
    const { t, projectId, register } = await setup();
    const args = { projectId, sandboxId: "e2b:sbx_1", generation: 0, replacesPreviews: true };

    await expect(
      t.mutation(api.runtimeHandles.registerRuntime, { internalKey: INTERNAL_KEY, ownerId: BOB, ...args }),
    ).rejects.toThrow("Unauthorized access to this project");
    await expect(
      t.mutation(api.runtimeHandles.registerRuntime, { internalKey: "wrong", ownerId: ALICE, ...args }),
    ).rejects.toThrow("Invalid internal key");
    await expect(
      t.query(api.runtimeHandles.getBootManifest, { internalKey: "wrong", projectId }),
    ).rejects.toThrow("Invalid internal key");
    expect(await register(0)).toBeTruthy();
  });
});
