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
  const deleteVar = (key = "API_KEY", ownerId = ALICE) =>
    t.mutation(api.envVars.deleteEnvVar, { internalKey: INTERNAL_KEY, projectId, ownerId, key });
  const revoked = (scope: { projectId?: Id<"projects">; sandboxId?: string } = {}) =>
    t.query(api.runtimeHandles.listRevokedHandles, { internalKey: INTERNAL_KEY, ...scope });
  const recordKill = (handleId: Id<"runtimeHandles">, killed: boolean) =>
    t.mutation(api.runtimeHandles.recordKill, { internalKey: INTERNAL_KEY, handleId, killed });
  return { t, projectId, alice, setSecret, read, register, admit, state, deleteVar, revoked, recordKill };
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
    expect(await admit(handleId)).toBe("admitted");
    expect(await state(handleId)).toBe("running");

    // An edit while it runs outdates it.
    await setSecret();
    expect(await state(handleId)).toBe("stale");
    expect((await read())!.generation).toBe(1);
  });

  test("a delete after the read and before register refuses admission", async () => {
    const { setSecret, read, deleteVar, register, admit, state } = await setup();
    await setSecret();
    const { generation } = (await read())!;

    await deleteVar();
    const handleId = await register(generation);

    expect(await admit(handleId)).toBe("outdated");
    expect(await state(handleId)).toBe("stale");
  });

  test("a delete between register and admit marks the pending handle stale and refuses it", async () => {
    const { setSecret, read, deleteVar, register, admit, state } = await setup();
    await setSecret();
    const handleId = await register((await read())!.generation);

    await deleteVar();
    expect(await state(handleId)).toBe("stale");
    expect(await admit(handleId)).toBe("outdated");
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
    expect(await s.admit(handleId)).toBe("admitted");

    await change(s);

    expect(await s.state(handleId)).toBe("stale");
  });

  test("a project delete during boot refuses admission and hides the manifest", async () => {
    const { setSecret, read, alice, register, admit, state, projectId } = await setup();
    await setSecret();
    const handleId = await register((await read())!.generation);

    await alice.mutation(api.projects.remove, { id: projectId });

    expect(await state(handleId)).toBe("stale");
    expect(await admit(handleId)).toBe("outdated");
    expect(await read()).toBeNull();
    await expect(register(1)).rejects.toThrow("Project not found");
  });

  test("an account delete outdates the owner's running previews", async () => {
    const { t, setSecret, read, register, admit, state } = await setup();
    await setSecret();
    const handleId = await register((await read())!.generation);
    expect(await admit(handleId)).toBe("admitted");

    await t.mutation(internal.users.markDeleted, { clerkUserId: ALICE });

    expect(await state(handleId)).toBe("stale");
  });

  test("a resume drops only its own sandbox's earlier handle; a fresh boot revokes every other preview", async () => {
    const { register, admit, state, revoked } = await setup();
    const first = await register(0, "e2b:sbx_a");
    await admit(first);
    const second = await register(0, "e2b:sbx_b", false);
    await admit(second);

    // Revoking it would get the resumed sandbox killed.
    const resumed = await register(0, "e2b:sbx_a", false);
    expect([await state(first), await state(second)]).toEqual([null, "running"]);
    expect(await revoked()).toEqual([]);

    // A fresh boot has tried to kill the others; the sweep confirms it.
    await register(0, "e2b:sbx_c");
    expect([await state(second), await state(resumed)]).toEqual(["stale", "stale"]);
    expect((await revoked()).map((handle) => handle.sandboxId).sort()).toEqual(["e2b:sbx_a", "e2b:sbx_b"]);
  });

  test("a failed kill denies the project's secret runtime until a later kill succeeds", async () => {
    const { setSecret, read, register, admit, state, revoked, recordKill, projectId } = await setup();
    const old = await register(0, "e2b:sbx_old");
    await admit(old);
    await setSecret();
    expect(await revoked({ projectId })).toEqual([{ _id: old, sandboxId: "e2b:sbx_old" }]);
    expect(await revoked({ sandboxId: "e2b:sbx_old" })).toHaveLength(1);
    expect(await revoked({ sandboxId: "e2b:sbx_new" })).toEqual([]);

    await recordKill(old, false);
    expect(await state(old)).toBe("revoke_failed");
    const blocked = await register((await read())!.generation, "e2b:sbx_new");
    expect(await admit(blocked)).toBe("blocked");

    // The sweep finds it again; a kill that succeeds (or finds it gone) removes it.
    expect(await revoked()).toEqual(expect.arrayContaining([{ _id: old, sandboxId: "e2b:sbx_old" }]));
    await recordKill(old, true);
    expect(await state(old)).toBeNull();
    expect(await admit(await register((await read())!.generation, "e2b:sbx_new"))).toBe("admitted");
  });

  test("recordKill leaves a live handle alone", async () => {
    const { register, admit, state, recordKill } = await setup();
    const handleId = await register(0);
    await admit(handleId);
    await recordKill(handleId, true);
    expect(await state(handleId)).toBe("running");
  });

  test("a boot replaced by a newer one while the env stayed as read is told so", async () => {
    const { register, admit } = await setup();
    const first = await register(0, "e2b:sbx_a");
    expect(await admit(await register(0, "e2b:sbx_b"))).toBe("admitted");
    expect(await admit(first)).toBe("replaced");
  });

  test("refuses a resume once the project holds MAX_LIVE_HANDLES other live handles", async () => {
    const { t, projectId, register } = await setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("runtimeHandles", { projectId, sandboxId: `e2b:sbx_${i}`, generation: 0, state: "running" });
      }
    });
    await expect(register(0, "e2b:sbx_new", false)).rejects.toThrow("Too many previews");
    // A fresh boot replaces them all.
    expect(await register(0, "e2b:sbx_new")).toBeTruthy();
  });

  test("admits a handle once", async () => {
    const { register, admit } = await setup();
    const handleId = await register(0);
    expect(await admit(handleId)).toBe("admitted");
    expect(await admit(handleId)).toBe("outdated");
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

describe("env changes that must go through a killing route", () => {
  test("deleteEnvVar is internal-key only and owner-checked", async () => {
    const { t, projectId, setSecret, deleteVar } = await setup();
    await setSecret();

    await expect(deleteVar("API_KEY", BOB)).rejects.toThrow("Unauthorized access to this project");
    await expect(
      t.mutation(api.envVars.deleteEnvVar, { internalKey: "wrong", projectId, ownerId: ALICE, key: "API_KEY" }),
    ).rejects.toThrow("Invalid internal key");
    await expect(deleteVar("MISSING")).rejects.toThrow("Environment variable not found");
    await deleteVar();
    expect(await t.run((ctx) => ctx.db.query("projectEnvVars").collect())).toEqual([]);
  });

  test("setPublicEnvVar refuses to turn an existing secret public", async () => {
    const { alice, projectId, setSecret, read } = await setup();
    await setSecret("VITE_TOKEN");

    await expect(
      alice.mutation(api.envVars.setPublicEnvVar, { projectId, key: "VITE_TOKEN", value: "x" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    expect((await read())!.records).toMatchObject([{ key: "VITE_TOKEN", visibility: "secret" }]);
  });
});
