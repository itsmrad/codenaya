// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { relistEntries, setFeatured, unlistTestEntries } from "./showcase";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;
type Seed = Partial<
  Pick<
    Doc<"showcaseProjects">,
    | "category"
    | "upvotes"
    | "importCount"
    | "techStack"
    | "designStyle"
    | "status"
    | "featured"
    | "ownerId"
    | "previewImageId"
  >
> & { title: string; publishedAt: number };

/** Inserts showcase entries, each with its own project, and returns their ids. */
async function seed(t: T, entries: Seed[]) {
  return await t.run(async (ctx) => {
    const ids: Id<"showcaseProjects">[] = [];
    for (const entry of entries) {
      const projectId = await ctx.db.insert("projects", {
        name: entry.title,
        ownerId: "user_alice",
        updatedAt: entry.publishedAt,
      });
      const id = await ctx.db.insert("showcaseProjects", {
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
      ids.push(id);
    }
    return ids;
  });
}

/** A stored file to use as a preview image. */
const storeImage = (t: T) =>
  t.run((ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));

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

describe("public showcase queries", () => {
  test("never return the project or owner id (#208)", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [{ title: "Weather widget", publishedAt: 1 }]);

    const listed = await t.query(api.showcase.list, { paginationOpts: page(10) });
    const searched = await t.query(api.showcase.search, {
      query: "weather",
      paginationOpts: page(10),
    });
    const trending = await t.query(api.showcase.getTrending, {});
    const byId = await t.query(api.showcase.getById, { id: listed.page[0]._id });

    for (const entry of [...listed.page, ...searched.page, ...trending, byId]) {
      expect(entry).toMatchObject({ title: "Weather widget", ownerName: "Alice" });
      expect(entry).not.toHaveProperty("projectId");
      expect(entry).not.toHaveProperty("ownerId");
    }
  });
});

describe("showcase.getFeatured", () => {
  test("lists only published, featured entries, newest first", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [
      { title: "old pick", publishedAt: 1, featured: true },
      { title: "new pick", publishedAt: 3, featured: true },
      { title: "popular", publishedAt: 2, upvotes: 99 },
      { title: "unpicked", publishedAt: 4, featured: false },
      { title: "unlisted pick", publishedAt: 5, featured: true, status: "unlisted" },
      { title: "removed pick", publishedAt: 6, featured: true, status: "removed" },
    ]);

    const featured = await t.query(api.showcase.getFeatured, {});
    expect(titles(featured)).toEqual(["new pick", "old pick"]);
    expect(featured[0]).not.toHaveProperty("projectId");
    expect(featured[0]).not.toHaveProperty("ownerId");
    expect(titles(await t.query(api.showcase.getFeatured, { limit: 1 }))).toEqual(["new pick"]);
    // Out-of-range limits are clamped rather than passed to the database.
    expect(titles(await t.query(api.showcase.getFeatured, { limit: -3 }))).toEqual(["new pick"]);
    expect(await t.query(api.showcase.getFeatured, { limit: 1e6 })).toHaveLength(2);
  });

  test("falls back to the most upvoted entries with a screenshot when nothing is featured", async () => {
    const t = convexTest(schema, modules);
    const imageId = await storeImage(t);
    await seed(t, [
      { title: "popular, no image", publishedAt: 1, upvotes: 99 },
      { title: "liked", publishedAt: 2, upvotes: 5, previewImageId: imageId },
      { title: "loved", publishedAt: 3, upvotes: 9, previewImageId: imageId },
      { title: "unlisted", publishedAt: 4, upvotes: 50, previewImageId: imageId, status: "unlisted" },
    ]);

    const fallback = await t.query(api.showcase.getFeatured, {});
    expect(titles(fallback)).toEqual(["loved", "liked"]);
    expect(fallback[0].previewUrl).toEqual(expect.any(String));
    expect(titles(await t.query(api.showcase.getFeatured, { limit: 1 }))).toEqual(["loved"]);
  });

  test("is empty when nothing is featured and no entry has a screenshot", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [{ title: "popular", publishedAt: 1, upvotes: 99 }]);

    expect(await t.query(api.showcase.getFeatured, {})).toEqual([]);
  });
});

describe("showcase.setFeatured", () => {
  test("is internal, so no client can call it", () => {
    expect(setFeatured.isInternal).toBe(true);
    expect(unlistTestEntries.isInternal).toBe(true);
    expect(relistEntries.isInternal).toBe(true);
  });

  test("features published entries with a screenshot, and unfeatures them", async () => {
    const t = convexTest(schema, modules);
    const imageId = await storeImage(t);
    const [id] = await seed(t, [{ title: "pick", publishedAt: 1, previewImageId: imageId }]);

    await t.mutation(internal.showcase.setFeatured, { id, featured: true });
    expect(titles(await t.query(api.showcase.getFeatured, {}))).toEqual(["pick"]);

    await t.mutation(internal.showcase.setFeatured, { id, featured: false });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.featured).toBe(false);
  });

  test("rejects entries without a screenshot or not published", async () => {
    const t = convexTest(schema, modules);
    const imageId = await storeImage(t);
    const [bare, unlisted] = await seed(t, [
      { title: "bare", publishedAt: 1 },
      { title: "unlisted", publishedAt: 2, status: "unlisted", previewImageId: imageId },
    ]);

    await expect(
      t.mutation(internal.showcase.setFeatured, { id: bare, featured: true })
    ).rejects.toThrow("Add a screenshot");
    await expect(
      t.mutation(internal.showcase.setFeatured, { id: unlisted, featured: true })
    ).rejects.toThrow("Only published entries");
  });
});

describe("unlisted entries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const TESTER = "user_e2e_pool_1";

  /** Publishes a fresh project as `subject`, returning the showcase id. */
  const publishAs = async (t: T, subject: string, email: string) => {
    const user = t.withIdentity({ subject, name: "Tester", email });
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Counter", ownerId: subject, updatedAt: 0 })
    );
    const id = await user.mutation(api.showcase.publish, {
      projectId,
      title: "Audit Counter",
      description: "",
      techStack: [],
      designStyle: [],
      category: "tool",
    });
    return { user, projectId, id };
  };

  const statusOf = (t: T, id: Id<"showcaseProjects">) =>
    t.run(async (ctx) => (await ctx.db.get(id))?.status);

  test("owners in SHOWCASE_UNLISTED_OWNER_IDS publish unlisted", async () => {
    vi.stubEnv("SHOWCASE_UNLISTED_OWNER_IDS", ` user_other , ${TESTER}`);
    const t = convexTest(schema, modules);
    const { user, projectId, id } = await publishAs(
      t,
      TESTER,
      "codenaya-e2e-1+clerk_test@example.com"
    );

    expect(await statusOf(t, id)).toBe("unlisted");
    const listed = await t.query(api.showcase.list, { paginationOpts: page(10) });
    const searched = await t.query(api.showcase.search, {
      query: "counter",
      paginationOpts: page(10),
    });
    expect(listed.page).toEqual([]);
    expect(searched.page).toEqual([]);
    expect(await t.query(api.showcase.getTrending, {})).toEqual([]);
    expect(await t.query(api.showcase.getById, { id })).toBeNull();

    // Its owner still sees it as published, and can't publish it twice.
    expect(await user.query(api.showcase.isProjectPublished, { projectId })).toMatchObject({
      _id: id,
    });
    await expect(
      user.mutation(api.showcase.publish, {
        projectId,
        title: "Again",
        description: "",
        techStack: [],
        designStyle: [],
        category: "tool",
      })
    ).rejects.toThrow("already published");
  });

  test("a real user with a test-like email publishes publicly", async () => {
    vi.stubEnv("SHOWCASE_UNLISTED_OWNER_IDS", TESTER);
    const t = convexTest(schema, modules);
    const real = await publishAs(t, "user_ada", "ada+clerk_test@example.com");
    expect(await statusOf(t, real.id)).toBe("published");

    vi.stubEnv("SHOWCASE_UNLISTED_OWNER_IDS", "");
    const tester = await publishAs(t, TESTER, "codenaya-e2e-1+clerk_test@example.com");
    expect(await statusOf(t, tester.id)).toBe("published");
  });

  describe("unlistTestEntries", () => {
    const seedMixed = (t: T) =>
      seed(t, [
        { title: "Seed feedabc 01", publishedAt: 1, ownerId: TESTER },
        { title: "Audit tip calc 68020", publishedAt: 2, ownerId: TESTER, featured: true },
        { title: "e2e of my wedding site", publishedAt: 3 },
        { title: "Seed feed planner", publishedAt: 4 },
      ]);

    test("is a dry run by default", async () => {
      const t = convexTest(schema, modules);
      const ids = await seedMixed(t);

      await t.mutation(internal.showcase.unlistTestEntries, { ownerIds: [TESTER] });

      const statuses = await Promise.all(ids.map((id) => statusOf(t, id)));
      expect(statuses).toEqual(["published", "published", "published", "published"]);
    });

    test("with apply, unlists only the listed owners' entries, and relistEntries undoes it", async () => {
      vi.stubEnv("SHOWCASE_UNLISTED_OWNER_IDS", TESTER);
      const t = convexTest(schema, modules);
      const ids = await seedMixed(t);

      await t.mutation(internal.showcase.unlistTestEntries, { apply: true });

      // Real users' entries stay listed, even with seed-like titles.
      const statuses = await Promise.all(ids.map((id) => statusOf(t, id)));
      expect(statuses).toEqual(["unlisted", "unlisted", "published", "published"]);
      const listed = await t.query(api.showcase.list, { paginationOpts: page(10) });
      expect(titles(listed.page)).toEqual(["Seed feed planner", "e2e of my wedding site"]);

      await t.mutation(internal.showcase.relistEntries, { ids: ids.slice(0, 2) });
      expect(await statusOf(t, ids[0])).toBe("published");
      expect(await statusOf(t, ids[1])).toBe("published");
    });

    test("refuses to run without owner ids", async () => {
      const t = convexTest(schema, modules);
      await expect(t.mutation(internal.showcase.unlistTestEntries, {})).rejects.toThrow(
        "SHOWCASE_UNLISTED_OWNER_IDS"
      );
    });
  });
});
