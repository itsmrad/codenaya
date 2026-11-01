// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { insertFileContent } from "./fileContents";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "p", ownerId: "alice", updatedAt: 0 });
    const other = await ctx.db.insert("projects", { name: "q", ownerId: "bob", updatedAt: 0 });
    const parentId = await ctx.db.insert("files", { projectId, name: "src", type: "folder", updatedAt: 0 });
    for (const [name, content, project, parent] of [
      ["app.ts", "hello.world\nhello world\nlast", projectId, parentId],
      ["root.ts", "hello world", projectId, undefined],
      ["secret.ts", "hello world", other, undefined],
      ["binary.bin", "hello\0world", projectId, undefined],
    ] as const) {
      const id = await ctx.db.insert("files", { projectId: project, parentId: parent, name, type: "file", updatedAt: 0 });
      await insertFileContent(ctx, id, project, content);
    }
    const storageId = await ctx.storage.store(new Blob(["hello world"]));
    await ctx.db.insert("files", { projectId, name: "stored.bin", type: "file", storageId, content: "hello world", updatedAt: 0 });
    return projectId;
  });
  const search = (args: Partial<{ pattern: string; isRegex: boolean; pathGlob: string; maxResults: number; internalKey: string }> = {}) =>
    t.query(api.files.searchFiles, { projectId, internalKey: "test-key", pattern: "hello", ...args });
  return { t, projectId, search };
}

test("literal default, nested paths, numbered matches, project isolation and binary skipping", async () => {
  const { search } = await setup();
  expect(await search({ pattern: "hello.world" })).toBe("src/app.ts:1: hello.world");
  const result = await search();
  expect(result).toContain("src/app.ts:2: hello world");
  expect(result).toContain("root.ts:1: hello world");
  expect(result).not.toMatch(/secret|binary|stored/);
});

test("regex and *, **, ? globs including root matches", async () => {
  const { search } = await setup();
  expect(await search({ pattern: "^hello.world$", isRegex: true, pathGlob: "src/*.ts" })).toBe("src/app.ts:1: hello.world\nsrc/app.ts:2: hello world");
  expect(await search({ pathGlob: "**/roo?.ts" })).toBe("root.ts:1: hello world");
  expect(await search({ pathGlob: "*.ts" })).toBe("root.ts:1: hello world");
  expect(await search({ pathGlob: "src/**/*.ts" })).toContain("src/app.ts:1:");
});

test("actionable invalid regex/arguments, safe pathological regex and internal-key gate", async () => {
  const { search, t, projectId } = await setup();
  expect(await search({ isRegex: true, pattern: "[" })).toContain("Error: Invalid regex");
  expect(await search({ isRegex: true, pattern: "(a)\\1" })).toContain("no backreferences");
  expect(await search({ pattern: "" })).toContain("Error:");
  expect(await search({ maxResults: 0 })).toContain("Error:");
  await expect(search({ internalKey: "wrong" })).rejects.toThrow("Invalid internal key");
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("files", { projectId, name: "adversarial", type: "file", updatedAt: 0 });
    await insertFileContent(ctx, id, projectId, "a".repeat(100_000) + "!");
  });
  const result = await search({ pattern: "(a+)+b$", isRegex: true });
  expect(result).not.toContain("adversarial:1:");
  expect(result).toContain("Regex search checked only the first 4,000 characters");
});

test("truncates matching lines with a narrowing hint, but not an exact result count", async () => {
  const { search } = await setup();
  expect(await search({ maxResults: 1 })).toContain("Search truncated. Narrow pathGlob or the pattern");
  expect(await search({ pattern: "hello.world", maxResults: 1 })).not.toContain("truncated");
});

test("bounds content reads and clips long result lines", async () => {
  const { search, t, projectId } = await setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 7; i++) {
      const id = await ctx.db.insert("files", { projectId, name: `large${i}`, type: "file", updatedAt: 0 });
      await insertFileContent(ctx, id, projectId, "x".repeat(800_000));
    }
  });
  const result = await search({ pattern: "x" });
  expect(result).toContain("line clipped");
  expect(result).toContain("Search truncated");
  expect(result.length).toBeLessThan(4000);
});

test("regex scans stop at 1 MiB while literal scans keep the 4 MiB budget", async () => {
  const { search, t, projectId } = await setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 2; i++) {
      const id = await ctx.db.insert("files", { projectId, name: `budget${i}.ts`, type: "file", updatedAt: 0 });
      await insertFileContent(ctx, id, projectId, "x".repeat(800_000));
    }
  });
  const regex = await search({ pattern: "^x", isRegex: true });
  expect(regex).toContain("budget0.ts:1:");
  expect(regex).not.toContain("budget1.ts:1:");
  expect(regex).toContain("Search truncated");
  const literal = await search({ pattern: "x" });
  expect(literal).toContain("budget0.ts:1:");
  expect(literal).toContain("budget1.ts:1:");
  expect(literal).not.toContain("Search truncated");
});

test("limits content index lookups to 3000, with explicit truncation", async () => {
  vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  const t = convexTest(schema, modules);
  const projectId = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { name: "many", ownerId: "alice", updatedAt: 0 });
    for (let i = 0; i <= 3000; i++) {
      const id = await ctx.db.insert("files", { projectId, name: `file${i}.ts`, type: "file", updatedAt: 0 });
      if (i >= 2999) await insertFileContent(ctx, id, projectId, "boundary");
    }
    return projectId;
  });
  const result = await t.query(api.files.searchFiles, { projectId, internalKey: "test-key", pattern: "boundary" });
  expect(result).toContain("file2999.ts:1: boundary");
  expect(result).not.toContain("file3000.ts:1:");
  expect(result).toContain("Search truncated");
});

test("normalises leading ./ and whitespace in path globs", async () => {
  const { search } = await setup();
  expect(await search({ pathGlob: " ./src/**/*.ts " })).toBe(await search({ pathGlob: "src/**/*.ts" }));
});

test("regex checks only the first 4,000 characters per line and reports the cutoff; literal search checks the suffix", async () => {
  const { search, t, projectId } = await setup();
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("files", { projectId, name: "minified.js", type: "file", updatedAt: 0 });
    await insertFileContent(ctx, id, projectId, "prefix" + "x".repeat(3994) + "suffix");
  });
  const regex = await search({ pattern: "suffix", isRegex: true });
  expect(regex).not.toContain("minified.js:1:");
  expect(regex).toContain("Search truncated");
  expect(regex).toContain("Regex search checked only the first 4,000 characters of each line");
  expect(await search({ pattern: "prefix", isRegex: true })).toContain("minified.js:1: prefix");
  const literal = await search({ pattern: "suffix" });
  expect(literal).toContain("minified.js:1:");
  expect(literal).not.toContain("Search truncated");
  expect(literal).not.toContain("Regex search checked only");
});
