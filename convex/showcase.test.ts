// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;
type Seed = Partial<
  Pick<
    Doc<"showcaseProjects">,
    "category" | "upvotes" | "importCount" | "techStack" | "designStyle" | "status"
  >
> & { title: string; publishedAt: number };

/** Inserts showcase entries, each with its own project. */
async function seed(t: T, entries: Seed[]) {
  await t.run(async (ctx) => {
    for (const entry of entries) {
      const projectId = await ctx.db.insert("projects", {
        name: entry.title,
        ownerId: "user_alice",
        updatedAt: entry.publishedAt,
      });
      await ctx.db.insert("showcaseProjects", {
        projectId,
        ownerId: "user_alice",
        ownerName: "Alice",
        description: "",
        techStack: [],
        designStyle: [],
        category: "tool",
        upvotes: 0,
        downvotes: 0,
        viewCount: 0,
        importCount: 0,
        status: "published",
        updatedAt: entry.publishedAt,
        ...entry,
      });
    }
  });
}

const page = (numItems: number, cursor: string | null = null) => ({ numItems, cursor });
const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe("showcase.list", () => {
  test("pages through every published project, newest first", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      ...Array.from({ length: 5 }, (_, i) => ({ title: `p${i}`, publishedAt: i, upvotes: 10 })),
      { title: "fresh", publishedAt: 100 },
      { title: "gone", publishedAt: 200, status: "removed" as const },
    ]);

    const first = await t.query(api.showcase.list, { paginationOpts: page(4) });
    expect(titles(first.page)).toEqual(["fresh", "p4", "p3", "p2"]);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.showcase.list, {
      paginationOpts: page(4, first.continueCursor),
    });
    expect(titles(second.page)).toEqual(["p1", "p0"]);
    expect(second.isDone).toBe(true);
  });

  test("sorts by upvotes and by imports, within a category too", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { title: "a", publishedAt: 1, upvotes: 3, importCount: 1, category: "game" },
      { title: "b", publishedAt: 2, upvotes: 1, importCount: 9, category: "game" },
      { title: "c", publishedAt: 3, upvotes: 2, importCount: 5, category: "tool" },
      { title: "d", publishedAt: 4, upvotes: 9, importCount: 0, category: "tool" },
    ]);

    const run = (args: { sortBy?: "newest" | "upvotes" | "imports"; category?: string }) =>
      t.query(api.showcase.list, { paginationOpts: page(10), ...args }).then((r) => titles(r.page));

    expect(await run({ sortBy: "upvotes" })).toEqual(["d", "a", "c", "b"]);
    expect(await run({ sortBy: "imports" })).toEqual(["b", "c", "a", "d"]);
    expect(await run({ category: "game" })).toEqual(["b", "a"]);
    expect(await run({ category: "game", sortBy: "upvotes" })).toEqual(["a", "b"]);
    expect(await run({ category: "tool", sortBy: "imports" })).toEqual(["c", "d"]);
  });

  test("filters by tech stack and design style", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { title: "react-min", publishedAt: 1, techStack: ["react"], designStyle: ["minimal"] },
      { title: "vue-min", publishedAt: 2, techStack: ["vue"], designStyle: ["minimal"] },
      { title: "react-retro", publishedAt: 3, techStack: ["react"], designStyle: ["retro"] },
    ]);

    const run = (args: { techStack?: string[]; designStyle?: string[] }) =>
      t.query(api.showcase.list, { paginationOpts: page(10), ...args }).then((r) => titles(r.page));

    expect(await run({ techStack: ["react"] })).toEqual(["react-retro", "react-min"]);
    expect(await run({ techStack: ["react", "vue"], designStyle: ["minimal"] })).toEqual([
      "vue-min",
      "react-min",
    ]);
    expect(await run({ techStack: [], designStyle: [] })).toHaveLength(3);
  });
});

describe("showcase.search", () => {
  test("finds published titles outside any top-N slice, filtered by category", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      ...Array.from({ length: 40 }, (_, i) => ({ title: `popular ${i}`, publishedAt: i, upvotes: 50 })),
      { title: "Weather widget", publishedAt: 100, category: "tool" },
      { title: "Weather game", publishedAt: 101, category: "game" },
      { title: "Weather hidden", publishedAt: 102, status: "removed" as const },
    ]);

    const all = await t.query(api.showcase.search, { query: "weather", paginationOpts: page(10) });
    expect(titles(all.page).sort()).toEqual(["Weather game", "Weather widget"]);

    const games = await t.query(api.showcase.search, {
      query: "weather",
      category: "game",
      paginationOpts: page(10),
    });
    expect(titles(games.page)).toEqual(["Weather game"]);
  });
});
