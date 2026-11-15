// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
beforeEach(() => vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "import-test-key"));
afterEach(() => vi.unstubAllEnvs());

async function setup(instructions?: string) {
  const t = convexTest(schema, modules);
  const projectId = await t.run((ctx) => ctx.db.insert("projects", {
    name: "Imported", ownerId: "alice", updatedAt: 0, instructions,
  }));
  const args = {
    internalKey: "import-test-key", projectId, status: "completed" as const,
    importInfo: { source: "bolt" as const, envVarNames: ["API_KEY", "VITE_SUPABASE_URL"] },
  };
  return { t, projectId, args };
}

it("stores names-only metadata, seeds neutral instructions and preserves it on status updates", async () => {
  const { t, projectId, args } = await setup();
  await t.mutation(api.system.updateImportStatus, args);
  await t.mutation(api.system.updateImportStatus, { internalKey: args.internalKey, projectId, status: "failed" });
  const project = await t.run((ctx) => ctx.db.get("projects", projectId));
  expect(project?.importInfo).toEqual(args.importInfo);
  expect(project?.instructions).toContain("Keep the existing hosted backend");
  expect(await t.run((ctx) => ctx.db.query("projectEnvVars").withIndex("by_project", (q) => q.eq("projectId", projectId)).take(1))).toEqual([]);
});

it("preserves user instructions and rejects a wrong internal key", async () => {
  const { t, projectId, args } = await setup("Keep my instructions");
  await expect(t.mutation(api.system.updateImportStatus, { ...args, internalKey: "wrong" })).rejects.toThrow();
  expect((await t.run((ctx) => ctx.db.get("projects", projectId)))?.importInfo).toBeUndefined();
  await t.mutation(api.system.updateImportStatus, args);
  expect((await t.run((ctx) => ctx.db.get("projects", projectId)))?.instructions).toBe("Keep my instructions");
  await expect(t.withIdentity({ subject: "bob" }).query(api.projects.getById, { id: projectId })).rejects.toThrow();
});

it("rejects values masquerading as names", async () => {
  const { t, args } = await setup();
  await expect(t.mutation(api.system.updateImportStatus, {
    ...args, importInfo: { envVarNames: ["API_KEY=fake-value"] },
  })).rejects.toThrow();
});
