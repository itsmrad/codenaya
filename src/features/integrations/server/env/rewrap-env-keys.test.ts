// @vitest-environment edge-runtime
/// <reference types="vite/client" />
/**
 * Key-move drill: two fake KMS providers (key A in one region, key B in
 * another) and a legacy local KEK, against the real Convex functions.
 */
import { randomBytes } from "node:crypto";

import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import schema from "../../../../../convex/schema";
import { createEnvSealer } from "../crypto/env-sealer";
import { createSecretSealer } from "../crypto/index";
import { createAwsKmsEnvKek, type KmsClientFactory } from "../crypto/kek/aws-kms";
import { ARN_A, ARN_B, ARN_UNKNOWN, createFakeKms, keySet } from "../crypto/kek/fake-kms.fixture";
import { createLocalKekProvider } from "../crypto/kek/local";
import { secretContext, type SealedSecret } from "../crypto/types";
import { emptyReport, mergeReport, runEnvKeyPage, type EnvKeyPassMode } from "./rewrap-env-keys";

const mocks = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));

const modules = import.meta.glob("../../../../../convex/**/*.ts");
const INTERNAL_KEY = "test-internal-key";
const OWNER = "user_owner";

let kmsA: ReturnType<typeof createFakeKms>;
let kmsB: ReturnType<typeof createFakeKms>;
// ARN_A and ARN_UNKNOWN live in ap-south-1 (fake A); ARN_B in eu-west-1 (fake B).
const factory: KmsClientFactory = (region, credentials) =>
  (region === "eu-west-1" ? kmsB : kmsA).factory(region, credentials);
const local = createLocalKekProvider({ activeKek: randomBytes(32).toString("base64") });
const sealerWith = (current: string, previous: string[] = []) =>
  createEnvSealer({ kms: () => createAwsKmsEnvKek(keySet(current, previous), factory), legacy: () => local });

beforeEach(() => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", INTERNAL_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  kmsA = createFakeKms();
  kmsB = createFakeKms();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setup() {
  const t = convexTest(schema, modules);
  mocks.query.mockImplementation(t.query);
  mocks.mutation.mockImplementation(t.mutation);
  const newProject = (name: string) =>
    t.run((ctx) => ctx.db.insert("projects", { name, ownerId: OWNER, updatedAt: 0 }));
  const save = (projectId: Id<"projects">, key: string, secretRef: string, sealed: SealedSecret) =>
    t.mutation(api.system.setSecretEnvVar, {
      internalKey: INTERNAL_KEY, projectId, ownerId: OWNER, key, secretRef, maskedPreview: "••••••••", source: "manual", ...sealed,
    });
  /** Seals a dummy canary under `current` (or the legacy KEK) and saves it. */
  const seed = async (projectId: Id<"projects">, key: string, current: string | "legacy") => {
    const secretRef = `ref_${key}`;
    const sealed =
      current === "legacy"
        ? await createSecretSealer(local).seal(`canary-${key}`, secretContext("projectEnvVars", secretRef, "value"))
        : await sealerWith(current).seal(`canary-${key}`, secretRef, { projectId, envKey: key });
    return save(projectId, key, secretRef, sealed);
  };
  const rows = () => t.run((ctx) => ctx.db.query("projectEnvVars").collect());
  const generations = () =>
    t.run(async (ctx) => (await ctx.db.query("projects").collect()).map((p) => p.envGeneration));
  const runAll = async (mode: EnvKeyPassMode, sealer = sealerWith(ARN_B, [ARN_A]), cursor: string | null = null) => {
    const report = emptyReport();
    for (;;) {
      const page = await runEnvKeyPage(mode, INTERNAL_KEY, cursor, { sealer, pageSize: 2 });
      mergeReport(report, page);
      if (page.done) return report;
      cursor = page.cursor;
    }
  };
  const openAll = async (sealer: ReturnType<typeof sealerWith>) =>
    Promise.all(
      (await rows())
        .filter((row) => row.visibility === "secret")
        .map((row) => sealer.open(row as SealedSecret, row.secretRef!, { projectId: row.projectId, envKey: row.key })),
    );
  return { t, newProject, save, seed, rows, generations, runAll, openAll };
}

test("a merged report counts the failures it stops listing", () => {
  const total = emptyReport();
  const page = (n: number) => ({
    byKey: { k: { total: n, failed: n } },
    failures: Array.from({ length: n }, (_, i) => ({ id: `row_${i}`, kekKeyId: "k" })),
  });
  for (let i = 0; i < 11; i++) mergeReport(total, page(50));
  expect(total.failures).toHaveLength(500);
  expect(total.unlistedFailures).toBe(50);
  expect(total.byKey.k).toEqual({ total: 550, failed: 550 });
});

describe("env-var KMS key move", () => {
  test("moves A and legacy rows to B, verifies, and rolls back by config", async () => {
    const { t, newProject, seed, rows, generations, runAll, openAll } = await setup();
    const p1 = await newProject("one");
    const p2 = await newProject("two");
    await seed(p1, "DB_URL", ARN_A);
    const oldEpoch = await seed(p1, "API_KEY", ARN_A);
    await seed(p1, "LEGACY_TOKEN", "legacy");
    await seed(p2, "DB_URL", ARN_A);
    await seed(p2, "STRIPE_KEY", ARN_A);
    await t.run((ctx) => ctx.db.insert("projectEnvVars", {
      projectId: p2, ownerId: OWNER, key: "VITE_SITE", visibility: "public", plainValue: "https://example.test", maskedPreview: "https://example.test", source: "manual", updatedAt: 1,
    }));
    // A row from an older recovery epoch, still awaiting the owner's review.
    await t.run((ctx) => ctx.db.patch("projectEnvVars", oldEpoch, { recoveryEpoch: 0 }));

    const before = await rows();
    const generationsBefore = await generations();

    expect((await runAll("verify")).byKey).toEqual({
      [ARN_A]: { total: 4, failed: 4 },
      [local.activeKeyId]: { total: 1, failed: 1 },
    });

    const moved = await runAll("rewrap");
    expect(moved.byKey).toEqual({
      [ARN_A]: { total: 4, moved: 4 },
      [local.activeKeyId]: { total: 1, moved: 1 },
    });
    expect(moved.failures).toEqual([]);

    const after = await rows();
    for (const row of after) {
      const old = before.find((b) => b._id === row._id)!;
      if (row.visibility === "public") {
        expect(row).toEqual(old);
        continue;
      }
      // Only the wrap moved: the value ciphertext, its revision and its epoch are untouched.
      expect(row).toEqual({ ...old, kekProvider: "aws-kms", kekKeyId: ARN_B, wrappedDek: row.wrappedDek });
      expect(row.wrappedDek).not.toBe(old.wrappedDek);
    }
    expect(after.find((row) => row._id === oldEpoch)?.recoveryEpoch).toBe(0);
    expect(await generations()).toEqual(generationsBefore);

    expect(await runAll("verify")).toEqual({ byKey: { [ARN_B]: { total: 5, wrapVerified: 5 } }, failures: [] });
    expect((await openAll(sealerWith(ARN_B, [ARN_A]))).sort()).toEqual(
      ["canary-API_KEY", "canary-DB_URL", "canary-DB_URL", "canary-LEGACY_TOKEN", "canary-STRIPE_KEY"],
    );

    // Re-running is a no-op that calls no KMS Encrypt.
    const encrypts = kmsB.state.encrypts.length;
    expect((await runAll("rewrap")).byKey).toEqual({ [ARN_B]: { total: 5, alreadyCurrent: 5 } });
    expect(kmsB.state.encrypts.length).toBe(encrypts);

    // Rollback is config only: A current again, B kept in the set. Rows on
    // either key open, and new saves go to A.
    const rolledBack = sealerWith(ARN_A, [ARN_B]);
    expect(await openAll(rolledBack)).toHaveLength(5);
    const saved = await rolledBack.seal("canary-new", "ref_new", { projectId: p1, envKey: "NEW_KEY" });
    expect(saved.kekKeyId).toBe(ARN_A);
    expect(await sealerWith(ARN_B, [ARN_A]).open(saved, "ref_new", { projectId: p1, envKey: "NEW_KEY" })).toBe("canary-new");
    // And the same runner moves everything back.
    expect((await runAll("rewrap", rolledBack)).byKey).toEqual({ [ARN_B]: { total: 5, moved: 5 } });
    expect((await runAll("verify", rolledBack)).byKey).toEqual({ [ARN_A]: { total: 5, wrapVerified: 5 } });
  });

  test("a run killed midway resumes, and a KMS outage leaves rows untouched", async () => {
    const { newProject, seed, rows, runAll } = await setup();
    const p = await newProject("resume");
    for (const key of ["K1", "K2", "K3", "K4", "K5"]) await seed(p, key, ARN_A);
    const sealer = sealerWith(ARN_B, [ARN_A]);

    const first = await runEnvKeyPage("rewrap", INTERNAL_KEY, null, { sealer, pageSize: 2 });
    expect(first.byKey).toEqual({ [ARN_A]: { total: 2, moved: 2 } });

    kmsB.state.down = true;
    const second = await runEnvKeyPage("rewrap", INTERNAL_KEY, first.cursor, { sealer, pageSize: 2 });
    expect(second.byKey).toEqual({ [ARN_A]: { total: 2, failed: 2 } });
    expect((await rows()).filter((row) => row.kekKeyId === ARN_A)).toHaveLength(3);
    // The process dies here.

    kmsB.state.down = false;
    expect((await runAll("rewrap")).byKey).toEqual({
      [ARN_B]: { total: 2, alreadyCurrent: 2 },
      [ARN_A]: { total: 3, moved: 3 },
    });
    expect((await runAll("verify")).byKey).toEqual({ [ARN_B]: { total: 5, wrapVerified: 5 } });
  });

  test("a save or delete during the run wins", async () => {
    const { t, newProject, seed, save, rows, runAll } = await setup();
    const p = await newProject("race");
    const edited = await seed(p, "EDITED", ARN_A);
    await seed(p, "DELETED", ARN_A);
    await seed(p, "UNTOUCHED", ARN_A);
    // A project being deleted is not written to either.
    const dying = await newProject("dying");
    await seed(dying, "GONE_SOON", ARN_A);
    await t.run((ctx) => ctx.db.patch("projects", dying, { deletingAt: 1 }));
    const fresh = await sealerWith(ARN_B, [ARN_A]).seal("canary-edited-2", "ref_edited_2", { projectId: p, envKey: "EDITED" });

    // Before the first compare-and-set lands, the owner edits one row and deletes another.
    let race: Promise<unknown> | undefined;
    mocks.mutation.mockImplementation(async (ref, args) => {
      if (getFunctionName(ref) === getFunctionName(api.envKeyRewrap.rewrapEnvVarDek)) {
        await (race ??= save(p, "EDITED", "ref_edited_2", fresh).then(() =>
          t.mutation(api.envVars.deleteEnvVar, { internalKey: INTERNAL_KEY, projectId: p, ownerId: OWNER, key: "DELETED" })));
      }
      return t.mutation(ref, args);
    });

    expect((await runAll("rewrap")).byKey).toEqual({ [ARN_A]: { total: 4, skipped: 3, moved: 1 } });
    const after = await rows();
    expect(after.map((row) => row.key).sort()).toEqual(["EDITED", "GONE_SOON", "UNTOUCHED"]);
    expect(after.find((row) => row.key === "GONE_SOON")?.kekKeyId).toBe(ARN_A);
    expect(after.find((row) => row._id === edited)).toMatchObject({ secretRef: "ref_edited_2", ...fresh });
    expect(after.find((row) => row.key === "UNTOUCHED")?.kekKeyId).toBe(ARN_B);
  });

  test("an unknown ARN or a swapped envelope fails closed and is named by id", async () => {
    const { t, newProject, seed, rows, runAll } = await setup();
    const p = await newProject("refuse");
    const unknown = await seed(p, "UNKNOWN", ARN_UNKNOWN);
    const good = await seed(p, "GOOD", ARN_A);
    const swapped = await seed(p, "SWAPPED", ARN_A);
    // Copy GOOD's whole envelope onto SWAPPED: KMS rejects it under SWAPPED's context.
    const goodRow = (await rows()).find((row) => row._id === good)!;
    await t.run((ctx) => ctx.db.patch("projectEnvVars", swapped, {
      wrappedDek: goodRow.wrappedDek, ciphertext: goodRow.ciphertext, iv: goodRow.iv, authTag: goodRow.authTag,
    }));
    const before = await rows();
    const decryptsBefore = kmsA.state.decrypts.length;

    const report = await runAll("rewrap");
    expect(report.byKey).toEqual({ [ARN_UNKNOWN]: { total: 1, failed: 1 }, [ARN_A]: { total: 2, moved: 1, failed: 1 } });
    expect(report.failures).toEqual([
      { id: unknown, kekKeyId: ARN_UNKNOWN },
      { id: swapped, kekKeyId: ARN_A },
    ]);
    // The unknown ARN never reached KMS.
    expect(kmsA.state.decrypts.slice(decryptsBefore).map((input) => input.KeyId)).not.toContain(ARN_UNKNOWN);
    const after = await rows();
    for (const id of [unknown, swapped]) {
      expect(after.find((row) => row._id === id)).toEqual(before.find((row) => row._id === id));
    }
    expect((await runAll("verify")).failures.map((failure) => failure.id).sort()).toEqual([unknown, swapped].sort());
  });
});
