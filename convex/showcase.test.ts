// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { relistEntries, setFeatured, unlistTestEntries } from "./showcase";
import { deleteShowcaseBatch } from "./projectCascade";

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
      expect(entry).not.toHaveProperty("previewImageId");
    }
  });
});

describe("showcase.publish", () => {
  const entry = {
    title: "Todo",
    description: "",
    techStack: [],
    designStyle: [],
    category: "tool",
  };

  test("refuses a preview the caller didn't upload, and accepts a fresh one (#211)", async () => {
    const t = convexTest(schema, modules);
    const bob = t.withIdentity({ subject: "user_bob", name: "Bob" });
    const [aliceEntry] = await seed(t, [{ title: "Alice's", publishedAt: 1, previewImageId: await storeImage(t) }]);
    const alicePreview = (await t.run((ctx) => ctx.db.get(aliceEntry)))!.previewImageId!;
    const missing = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["png"]));
      await ctx.storage.delete(id);
      return id;
    });
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Todo", ownerId: "user_bob", updatedAt: 0 })
    );

    for (const previewImageId of [alicePreview, missing]) {
      await expect(
        bob.mutation(api.showcase.publish, { ...entry, projectId, previewImageId })
      ).rejects.toThrow("Upload not found");
    }

    const fresh = await storeImage(t);
    const id = await bob.mutation(api.showcase.publish, { ...entry, projectId, previewImageId: fresh });
    expect((await t.run((ctx) => ctx.db.get(id)))?.previewImageId).toBe(fresh);
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
    expect(await user.query(api.showcase.isProjectPublished, { projectId })).toBe(id);
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

describe("showcase.incrementView (#269)", () => {
  const ANON = "anon_123e4567-e89b-42d3-a456-426614174000";
  const viewsOf = (t: T, id: Id<"showcaseProjects">) =>
    t.run(async (ctx) => (await ctx.db.get(id))?.viewCount);

  test("counts each viewer once, never the owner, and ignores malformed anonymous ids", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Counter", publishedAt: 1 }]);
    const owner = t.withIdentity({ subject: "user_alice" });
    const bob = t.withIdentity({ subject: "user_bob" });

    await owner.mutation(api.showcase.incrementView, { id });
    expect(await viewsOf(t, id)).toBe(0);

    await bob.mutation(api.showcase.incrementView, { id });
    await bob.mutation(api.showcase.incrementView, { id });
    await t.mutation(api.showcase.incrementView, { id, anonymousId: ANON });
    await t.mutation(api.showcase.incrementView, { id, anonymousId: ANON });
    expect(await viewsOf(t, id)).toBe(2);

    // A Clerk-shaped id can't pre-claim Bob's view; no id counts nothing.
    await t.mutation(api.showcase.incrementView, { id, anonymousId: "user_carol" });
    await t.mutation(api.showcase.incrementView, { id });
    expect(await viewsOf(t, id)).toBe(2);
  });

  test("publish names an email-only author by their email's local part", async () => {
    const t = convexTest(schema, modules);
    const user = t.withIdentity({ subject: "user_ada", email: "ada.l@example.com" });
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Counter", ownerId: "user_ada", updatedAt: 0 })
    );
    const id = await user.mutation(api.showcase.publish, {
      projectId,
      title: "Counter",
      description: "",
      techStack: [],
      designStyle: [],
      category: "tool",
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.ownerName)).toBe("ada.l");
  });
});

describe("showcase.isProjectPublished", () => {
  test("answers its owner with the entry id and refuses anyone else (#239)", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Todo", publishedAt: 1 }]);
    const projectId = await t.run(async (ctx) => (await ctx.db.get(id))!.projectId);

    const alice = t.withIdentity({ subject: "user_alice" });
    expect(await alice.query(api.showcase.isProjectPublished, { projectId })).toBe(id);
    await expect(
      t.withIdentity({ subject: "user_bob" }).query(api.showcase.isProjectPublished, { projectId })
    ).rejects.toThrow("Unauthorized");

    await t.run((ctx) => ctx.db.patch(id, { status: "removed" }));
    expect(await alice.query(api.showcase.isProjectPublished, { projectId })).toBeNull();
  });

  test("publish -> unpublish -> republish keeps one published entry (#210)", async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity({ subject: "user_alice" });
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { name: "Todo", ownerId: "user_alice", updatedAt: 0 })
    );
    const publish = async (title: string) =>
      alice.mutation(api.showcase.publish, {
        projectId,
        title,
        previewImageId: await storeImage(t),
        description: "",
        techStack: [],
        designStyle: [],
        category: "tool",
      });

    const id = await publish("First");
    const firstPreview = (await t.run((ctx) => ctx.db.get(id)))!.previewImageId!;
    await t.run((ctx) => ctx.db.patch(id, { upvotes: 3, featured: true }));
    await alice.mutation(api.showcase.unpublish, { id });
    expect(await alice.query(api.showcase.isProjectPublished, { projectId })).toBeNull();

    // Republishing refreshes the same entry, votes included, and a second publish is refused.
    expect(await publish("Second")).toBe(id);
    expect(await t.run((ctx) => ctx.db.system.get(firstPreview))).toBeNull();
    expect(await alice.query(api.showcase.isProjectPublished, { projectId })).toBe(id);
    await expect(publish("Third")).rejects.toThrow("already published");

    const rows = await t.run((ctx) => ctx.db.query("showcaseProjects").collect());
    expect(rows.map(({ title, status, upvotes, featured }) => ({ title, status, upvotes, featured }))).toEqual([
      { title: "Second", status: "published", upvotes: 3, featured: undefined },
    ]);
    expect(await t.run((ctx) => ctx.db.system.get(rows[0].previewImageId!))).not.toBeNull();
  });
});

test("a published entry of a user whose deletion started leaves every public read", async () => {
  vi.useFakeTimers(); // keeps the scheduled purge from running
  try {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Weather", publishedAt: 1, featured: true }]);
    const reads = async () => {
      const list = await t.query(api.showcase.list, { paginationOpts: page(10) });
      const search = await t.query(api.showcase.search, { query: "weather", paginationOpts: page(10) });
      return [
        list.page.length,
        search.page.length,
        (await t.query(api.showcase.getById, { id })) ? 1 : 0,
        (await t.query(api.showcase.getTrending, {})).length,
        (await t.query(api.showcase.getFeatured, {})).length,
      ];
    };
    expect(await reads()).toEqual([1, 1, 1, 1, 1]);

    await t.mutation(internal.users.markDeleted, { clerkUserId: "user_alice" });

    expect(await reads()).toEqual([0, 0, 0, 0, 0]);
  } finally {
    vi.useRealTimers();
  }
});

describe("showcase.importToWorkspace", () => {
  const importAs = (t: T, subject: string, showcaseProjectId: Id<"showcaseProjects">) =>
    t.withIdentity({ subject }).mutation(api.showcase.importToWorkspace, { showcaseProjectId });
  const importCountOf = (t: T, id: Id<"showcaseProjects">) =>
    t.run(async (ctx) => (await ctx.db.get(id))?.importCount);

  test("counts one import per user (#239)", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Todo", publishedAt: 1 }]);

    await importAs(t, "user_bob", id);
    await importAs(t, "user_bob", id);
    expect(await importCountOf(t, id)).toBe(1);

    await importAs(t, "user_carol", id);
    expect(await importCountOf(t, id)).toBe(2);
  });

  test("refuses a source project that is being deleted (#239)", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Todo", publishedAt: 1 }]);
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.get(id))!.projectId, { deletingAt: 1 }));

    await expect(importAs(t, "user_bob", id)).rejects.toThrow("Project not found");
    expect(await importCountOf(t, id)).toBe(0);
  });

  test("refuses imports past the hourly project limit", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "Todo", publishedAt: 1 }]);
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("projects", { name: `p${i}`, ownerId: "user_bob", updatedAt: 0 });
      }
    });

    await expect(importAs(t, "user_bob", id)).rejects.toThrow("per hour");
    expect(await importCountOf(t, id)).toBe(0);
  });
});

// A client-supplied limit is clamped to 1-50 (#212).
test("getTrending clamps its limit", async () => {
  const t = convexTest(schema, modules);
  await seed(t, Array.from({ length: 55 }, (_, i) => ({ title: `e${i}`, publishedAt: i })));

  expect(await t.query(api.showcase.getTrending, { limit: 1000 })).toHaveLength(50);
  expect(await t.query(api.showcase.getTrending, { limit: 0 })).toHaveLength(1);
});

describe("weekly showcase", () => {
  const now = Date.UTC(2026, 10, 15, 12);
  const day = 24 * 60 * 60 * 1000;
  afterEach(() => vi.useRealTimers());

  test("records only new upvotes and deduplicates same-day toggles in the score", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "demo", publishedAt: 1 }]);
    const user = t.withIdentity({ subject: "user_bob" });
    const vote = (value: "up" | "down") => user.mutation(api.showcase.vote, { showcaseProjectId: id, vote: value });
    await vote("down"); // A downvote and a switch to up add no events.
    await vote("up");
    expect(await t.run((ctx) => ctx.db.query("showcaseEvents").take(10))).toEqual([]);
    await vote("up"); // Remove.
    await vote("up"); // New upvote.
    await vote("up"); // Remove.
    await vote("up"); // New upvote, same day.
    const events = await t.run((ctx) => ctx.db.query("showcaseEvents").take(10));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ showcaseProjectId: id, kind: "upvote", userId: "user_bob", createdAt: now });
    expect(await t.query(api.showcase.getTopCreators, { now })).toEqual([
      { name: "Alice", avatarUrl: null, score: 1 },
    ]);
  });

  test("records a counted remix, excludes self-remixes and repeat imports", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "demo", publishedAt: 1 }]);
    await t.withIdentity({ subject: "user_alice" }).mutation(api.showcase.importToWorkspace, { showcaseProjectId: id });
    const user = t.withIdentity({ subject: "user_bob" });
    await user.mutation(api.showcase.importToWorkspace, { showcaseProjectId: id });
    await user.mutation(api.showcase.importToWorkspace, { showcaseProjectId: id });
    const events = await t.run((ctx) => ctx.db.query("showcaseEvents").take(10));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ showcaseProjectId: id, kind: "remix", userId: "user_bob" });
  });

  test("ranks recent weighted events, ignoring old, future, unlisted and removed activity", async () => {
    const t = convexTest(schema, modules);
    const [up, remix, old, hidden, removed] = await seed(t, [
      { title: "up", publishedAt: 5, upvotes: 100, category: "game" },
      { title: "remix", publishedAt: 1, category: "tool", ownerId: "user_bob" },
      { title: "old", publishedAt: 10, upvotes: 1000 },
      { title: "hidden", publishedAt: 20, status: "unlisted" },
      { title: "removed", publishedAt: 30, status: "removed" },
    ]);
    await t.run(async (ctx) => {
      for (const [id, kind, createdAt] of [
        [up, "upvote", now - 7 * day], // Inclusive boundary.
        [remix, "remix", now],
        [old, "remix", now - 7 * day - 1],
        [old, "remix", now + 1],
        [hidden, "remix", now],
        [removed, "remix", now],
      ] as const) {
        await ctx.db.insert("showcaseEvents", { showcaseProjectId: id, kind, createdAt, userId: "voter" });
      }
    });
    const first = await t.query(api.showcase.list, { sortBy: "week", now, paginationOpts: page(1) });
    expect(titles(first.page)).toEqual(["remix"]);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.showcase.list, { sortBy: "week", now, paginationOpts: page(1, first.continueCursor) });
    expect(titles(second.page)).toEqual(["up"]);
    expect(second.isDone).toBe(true);
    const filtered = await t.query(api.showcase.list, { sortBy: "week", now, category: "game", paginationOpts: page(10) });
    expect(titles(filtered.page)).toEqual(["up"]);
    expect(first.page[0]).not.toHaveProperty("ownerId");
    expect(first.page[0]).not.toHaveProperty("projectId");
    expect((await t.query(api.showcase.list, { sortBy: "week", now, techStack: ["react"], paginationOpts: page(10) })).page).toEqual([]);
    const creators = await t.query(api.showcase.getTopCreators, { now, limit: 100 });
    expect(creators.map((creator) => creator.score)).toEqual([2, 1]);
    expect(Object.keys(creators[0]).sort()).toEqual(["avatarUrl", "name", "score"]);
  });

  test("returns an empty weekly page and creators for legacy entries with no events", async () => {
    const t = convexTest(schema, modules);
    await seed(t, [{ title: "legacy", publishedAt: 1, upvotes: 99 }]);
    const result = await t.query(api.showcase.list, { sortBy: "week", now, paginationOpts: page(12) });
    expect(result.page).toEqual([]);
    expect(result.isDone).toBe(true);
    expect(await t.query(api.showcase.getTopCreators, { now })).toEqual([]);
    expect(titles((await t.query(api.showcase.list, { paginationOpts: page(12) })).page)).toEqual(["legacy"]);
  });

  test("caps creators at five and sums scores across each owner's entries", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t, Array.from({ length: 7 }, (_, i) => ({
      title: `p${i}`, publishedAt: i, ownerId: `owner${i % 6}`,
    })));
    await t.run(async (ctx) => {
      for (const id of ids) await ctx.db.insert("showcaseEvents", {
        showcaseProjectId: id, kind: "upvote", userId: "voter", createdAt: now,
      });
    });
    const creators = await t.query(api.showcase.getTopCreators, { now, limit: 100 });
    expect(creators).toHaveLength(5);
    expect(creators[0].score).toBe(2);
  });

  test("deletes timestamped events with their showcase entry", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "demo", publishedAt: 1 }]);
    await t.withIdentity({ subject: "user_bob" }).mutation(api.showcase.vote, { showcaseProjectId: id, vote: "up" });
    await t.run(async (ctx) => {
      const entry = await ctx.db.get("showcaseProjects", id);
      if (!entry) throw new Error("Missing seed");
      expect(await deleteShowcaseBatch(ctx, entry)).toBe(false); // Votes.
      expect(await deleteShowcaseBatch(ctx, entry)).toBe(false); // Events.
      expect(await deleteShowcaseBatch(ctx, entry)).toBe(true);
    });
    expect(await t.run((ctx) => ctx.db.query("showcaseEvents").take(10))).toEqual([]);
  });

  test("refuses unauthenticated event writes", async () => {
    const t = convexTest(schema, modules);
    const [id] = await seed(t, [{ title: "demo", publishedAt: 1 }]);
    await expect(t.mutation(api.showcase.vote, { showcaseProjectId: id, vote: "up" })).rejects.toThrow();
    await expect(t.mutation(api.showcase.importToWorkspace, { showcaseProjectId: id })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("showcaseEvents").take(10))).toEqual([]);
  });
});
