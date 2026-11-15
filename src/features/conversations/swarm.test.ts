import { createTool } from "@inngest/agent-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { guardOwnedPaths } from "./inngest/lib/ownership-guard";
import { MAX_BRIEF_CHARS, classifySwarmPrompt, isFoundationPath, ownsPath, swarmPlanSchema, validatePlan } from "./swarm";

const task = (id: string, ownedPaths: string[]) => ({ id, title: id, brief: `Build ${id}.`, ownedPaths });

describe("swarmPlanSchema", () => {
  it("accepts an empty task list with a solo reason", () => {
    expect(swarmPlanSchema.parse({ tasks: [], solo: "x" })).toEqual({ tasks: [], solo: "x" });
  });

  it.each([2, 3, 4])("accepts %i tasks", (count) => {
    const tasks = Array.from({ length: count }, (_, i) => task(`task-${i}`, [`src/${i}.ts`]));
    expect(swarmPlanSchema.safeParse({ tasks }).success).toBe(true);
  });

  it.each([0, 1, 5, 6])("rejects %i tasks without a solo reason", (count) => {
    const tasks = Array.from({ length: count }, (_, i) => task(`task-${i}`, [`src/${i}.ts`]));
    expect(swarmPlanSchema.safeParse({ tasks }).success).toBe(false);
  });

  it("rejects one task even with a solo reason", () => {
    expect(swarmPlanSchema.safeParse({ tasks: [task("a", ["src/a.ts"])], solo: "x" }).success).toBe(false);
  });

  it("emits the tool JSON schema without a minimum task count", () => {
    const schema = z.toJSONSchema(swarmPlanSchema, { target: "draft-7" });
    expect(schema.properties?.tasks).not.toHaveProperty("minItems");
    expect(schema.properties?.tasks).toHaveProperty("maxItems", 4);
  });
});

describe("validatePlan", () => {
  it("accepts 2-4 tasks owning disjoint files and folders under src/, normalised", () => {
    const plan = { tasks: [task("nav", ["src/components/nav/"]), task("hero", ["./src/components/hero.tsx"])] };
    expect(validatePlan(plan)).toEqual({
      tasks: [task("nav", ["src/components/nav"]), task("hero", ["src/components/hero.tsx"])],
    });
  });

  it("accepts a detailed brief and names the task, length and limit for one over the cap (#646)", () => {
    const long = { ...task("pages", ["src/pages/"]), brief: "x".repeat(5000) };
    expect(validatePlan({ tasks: [long, task("nav", ["src/nav.tsx"])] })).toMatchObject({ tasks: [{ brief: long.brief }, {}] });
    const over = { ...long, brief: "x".repeat(MAX_BRIEF_CHARS + 1) };
    expect(validatePlan({ tasks: [task("nav", ["src/nav.tsx"]), over] })).toBe(
      `Error: The brief for task pages is ${MAX_BRIEF_CHARS + 1} characters; the limit is ${MAX_BRIEF_CHARS}. Shorten it and call delegateTasks again.`,
    );
  });

  it("refuses too few or too many tasks", () => {
    expect(validatePlan({ tasks: [] })).toMatch(/^Error: Delegate 2-4 tasks, or pass tasks \[\] with solo/);
    expect(validatePlan({ tasks: [task("a", ["src/a.ts"])] })).toMatch(/^Error: Delegate 2-4 tasks, or pass tasks \[\] with solo/);
    const five = ["a", "b", "c", "d", "e"].map((id) => task(id, [`src/${id}.ts`]));
    expect(validatePlan({ tasks: five })).toMatch(/^Error:/);
  });

  it("refuses overlapping ownership, either way round", () => {
    expect(validatePlan({ tasks: [task("a", ["src/ui/"]), task("b", ["src/ui/button.tsx"])] })).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("a", ["src/ui/button.tsx"]), task("b", ["src/ui/"])] })).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("a", ["src/ui"]), task("b", ["src/ui/x.ts"])] })).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("a", ["src/components"]), task("b", ["src/components/"])] })).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("a", ["src/a.ts"]), task("a", ["src/b.ts"])] })).toMatch(/unique/);
  });

  it("lets a task own public/ files or the folder, normalised, with overlap rules unchanged", () => {
    const plan = { tasks: [task("seo", ["./public/robots.txt", "public/sitemap.xml"]), task("pages", ["src/pages/"])] };
    expect(validatePlan(plan)).toEqual({
      tasks: [task("seo", ["public/robots.txt", "public/sitemap.xml"]), task("pages", ["src/pages"])],
    });
    expect(validatePlan({ tasks: [task("a", ["public/"]), task("b", ["src/b.ts"])] })).toMatchObject({ tasks: [{ ownedPaths: ["public"] }, {}] });
    expect(validatePlan({ tasks: [task("a", ["public"]), task("b", ["public/logo.svg"])] })).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("a", ["public/favicon.svg"]), task("b", ["public/favicon.svg"])] })).toMatch(/overlap/);
  });

  it.each(["index.html", "package.json", "vite.config.ts", "public-old/x.png", "publicfoo"])("explains how to fix outside-src/public ownership: %s", (path) => {
    expect(validatePlan({ tasks: [task("a", [path]), task("b", ["src/b.ts"])] })).toBe(
      `Error: Owned path "${path}" is outside src/ and public/. Tasks own paths under src/ or public/; index.html and root config files are yours: write them before delegating, or drop it from ownedPaths, then call delegateTasks again.`,
    );
  });

  it.each(["src/../x", "/src/x.ts", "src//x.ts", "public/../index.html", "/public/x.png", ""])("keeps a clear malformed path error: %s", (path) => {
    expect(validatePlan({ tasks: [task("a", [path]), task("b", ["src/b.ts"])] })).toBe(
      `Error: Invalid owned path "${path}"; use a project-relative path under src/ or public/.`,
    );
  });

  it("refuses shared files, folders holding one, and outside, absolute or parent paths", () => {
    for (const path of ["src/App.tsx", "src/lib", "src/lib/", "src", "src/", "src/index.css", "package.json", "index.html", "/src/x.ts", "src/../x.ts", "public/../index.html", "/public/x.png", "src//x.ts"]) {
      expect(validatePlan({ tasks: [task("a", [path]), task("b", ["src/b.ts"])] }), path).toMatch(/^Error:/);
    }
  });
});

describe("validatePlan roles and nesting", () => {
  const sub = (id: string, ownedPaths: string[]) => ({ ...task(id, ownedPaths), role: "sub-orchestrator" as const });
  const within = { withinPaths: ["src/shop"] };

  it("allows at most two sub-orchestrators", () => {
    expect(validatePlan({ tasks: [sub("a", ["src/a/"]), sub("b", ["src/b/"]), task("c", ["src/c.ts"])] })).toHaveProperty("tasks");
    expect(validatePlan({ tasks: [sub("a", ["src/a/"]), sub("b", ["src/b/"]), sub("c", ["src/c/"])] })).toMatch(/At most 2/);
    // A platform run without SWARM_PLATFORM_MAX_DEPTH=2 has workers only.
    expect(validatePlan({ tasks: [sub("a", ["src/a/"]), task("c", ["src/c.ts"])] }, { maxDepth: 1 })).toMatch(/Sub-orchestrators are off/);
    expect(validatePlan({ tasks: [task("a", ["src/a/"]), task("c", ["src/c.ts"])] }, { maxDepth: 1 })).toHaveProperty("tasks");
  });

  it("keeps a sub-orchestrator's 2-3 workers inside its paths and apart", () => {
    expect(validatePlan({ tasks: [task("cart", ["src/shop/cart/"]), task("list", ["src/shop/list.tsx"])] }, within))
      .toMatchObject({ tasks: [{ ownedPaths: ["src/shop/cart"] }, { ownedPaths: ["src/shop/list.tsx"] }] });
    expect(validatePlan({ tasks: [task("cart", ["src/shop/cart/"]), task("nav", ["src/nav.tsx"])] }, within)).toMatch(/outside your owned paths/);
    expect(validatePlan({ tasks: [task("all", ["src/shop"]), task("cart", ["src/shop/cart.tsx"])] }, within)).toMatch(/overlap/);
    expect(validatePlan({ tasks: [task("cart", ["src/shop/cart/"]), task("x", ["src/shop/cart/x.ts"])] }, within)).toMatch(/overlap/);
    // A trailing-slash or "./" spelling of the parent's own folder is the same path.
    expect(validatePlan({ tasks: [task("a", ["./src/shop/a.ts"]), task("b", ["src/shop/b.ts"])] }, { withinPaths: ["src/shop/"] })).toHaveProperty("tasks");
    const four = ["a", "b", "c", "d"].map((id) => task(id, [`src/shop/${id}.ts`]));
    expect(validatePlan({ tasks: four }, within)).toMatch(/at most 3/);
    expect(validatePlan({ tasks: [sub("a", ["src/shop/a/"]), task("b", ["src/shop/b.ts"])] }, within)).toMatch(/only be workers/);
  });
});

describe("ownsPath", () => {
  it("covers owned files and everything inside owned folders, nothing else", () => {
    const owned = ["src/pages/", "src/hooks/use-cart.ts"];
    expect(ownsPath(owned, "src/pages/home.tsx")).toBe(true);
    expect(ownsPath(owned, "src/pages")).toBe(true);
    expect(ownsPath(owned, "src/hooks/use-cart.ts")).toBe(true);
    expect(ownsPath(owned, "src/hooks/use-auth.ts")).toBe(false);
    expect(ownsPath(owned, "src/pages-old/x.tsx")).toBe(false);
    expect(ownsPath(owned, "src/pages/../App.tsx")).toBe(false);
    expect(ownsPath(["src/"], "src/App.tsx")).toBe(false);
    expect(ownsPath(owned, "./src/pages/home.tsx")).toBe(true);
  });

  it("covers public/ when owned, never index.html, root config or other tasks' files", () => {
    const owned = ["public/robots.txt", "public/images"];
    expect(ownsPath(owned, "public/robots.txt")).toBe(true);
    expect(ownsPath(owned, "./public/images/hero.png")).toBe(true);
    expect(ownsPath(owned, "public/sitemap.xml")).toBe(false);
    expect(ownsPath(owned, "public/../index.html")).toBe(false);
    expect(ownsPath(owned, "index.html")).toBe(false);
    expect(ownsPath(["public"], "index.html")).toBe(false);
    expect(ownsPath(["public"], "package.json")).toBe(false);
    expect(ownsPath(["public"], "public/sitemap.xml")).toBe(true);
    expect(ownsPath(["src/pages"], "public/robots.txt")).toBe(false);
  });

  it("treats an owned path without a slash as a folder too", () => {
    expect(ownsPath(["src/components"], "src/components/nav.tsx")).toBe(true);
    expect(ownsPath(["src/components"], "src/components/")).toBe(true);
  });

  it("refuses deleting a folder that holds a shared file or isn't wholly owned", () => {
    expect(ownsPath(["src/lib"], "src/lib")).toBe(false);
    expect(ownsPath(["src/lib"], "src/lib/utils.ts")).toBe(false);
    expect(ownsPath(["src/lib/format"], "src/lib")).toBe(false);
    expect(ownsPath(["src/lib/format"], "src/lib/format/date.ts")).toBe(true);
    expect(ownsPath(["src/components/nav.tsx"], "src/components")).toBe(false);
    expect(ownsPath(["src/pages"], "src")).toBe(false);
  });
});

describe("guardOwnedPaths", () => {
  const handler = vi.fn(async () => "ok");
  const guard = guardOwnedPaths(["src/pages/"]);
  const tool = (name: string) =>
    guard(createTool({ name, description: name, parameters: z.object({}).passthrough(), handler }));
  const call = (name: string, input: unknown) =>
    (tool(name).handler as (input: unknown, opts: never) => Promise<string>)(input, {} as never);

  it("refuses any write outside owned paths without running the tool", async () => {
    handler.mockClear();
    expect(await call("writeFiles", { files: [{ path: "src/pages/a.tsx" }, { path: "src/App.tsx" }] })).toMatch(/^Error: Write refused/);
    expect(await call("editFile", { path: "src/main.tsx" })).toMatch(/^Error/);
    expect(await call("deleteFiles", { paths: ["src/"] })).toMatch(/^Error/);
    expect(await call("deleteFiles", { paths: ["src/pages/a.tsx", "src/lib"] })).toMatch(/^Error/);
    expect(await call("deleteFiles", { fileIds: ["f1"] })).toMatch(/^Error/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets a worker write its owned public/ file, not another's, index.html or root files", async () => {
    handler.mockClear();
    const seo = guardOwnedPaths(["public/robots.txt"])(createTool({ name: "writeFiles", description: "w", parameters: z.object({}).passthrough(), handler }));
    const write = (path: string) => (seo.handler as (input: unknown, opts: never) => Promise<string>)({ files: [{ path }] }, {} as never);
    expect(await write("public/robots.txt")).toBe("ok");
    expect(await write("public/sitemap.xml")).toMatch(/^Error: Write refused/);
    expect(await write("index.html")).toMatch(/^Error: Write refused/);
    expect(await write("package.json")).toMatch(/^Error: Write refused/);
    expect(await write("public/../index.html")).toMatch(/^Error: Write refused/);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs owned writes and leaves reads unrestricted", async () => {
    handler.mockClear();
    expect(await call("writeFiles", { files: [{ path: "src/pages/a.tsx" }] })).toBe("ok");
    expect(await call("deleteFiles", { paths: ["src/pages/old/"] })).toBe("ok");
    expect(await call("readFiles", { paths: ["src/App.tsx"] })).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe("classifySwarmPrompt", () => {
  it.each([
    "Build a pizzeria site with home, menu, about and contact pages",
    "Make a website for a dental clinic: home, services, our dentists, appointments and contact",
    "Create a booking app where customers pick a service, choose a time slot and get a confirmation page, plus an admin view",
    "Build a CRM with contacts, a deals pipeline and a dashboard",
    "A 3-page portfolio site",
    "Add a menu page and a contact page",
    "add a login page and a dashboard",
  ])("delegates %j", (prompt) => {
    expect(classifySwarmPrompt(prompt)).toMatchObject({ delegate: true });
  });

  it.each([
    "change the button color to red",
    "Fix the typo in the footer",
    "Add a contact form to the home page",
    "update the header on the home and about pages",
    "Change the font on the menu and contact pages",
    "fix the navbar logo on the home, menu and about pages",
  ])("keeps %j solo as a small edit", (prompt) => {
    expect(classifySwarmPrompt(prompt)).toEqual({ delegate: false, reason: "a small edit" });
  });

  it("names the pages it counted, and keeps a short vague request solo", () => {
    expect(classifySwarmPrompt("Build a pizzeria site with home, menu, about and contact pages").reason)
      .toBe("it names 4 pages or features (home, menu, about, contact)");
    expect(classifySwarmPrompt("Build a todo app").delegate).toBe(false);
  });
});

describe("isFoundationPath", () => {
  it.each(["package.json", "vite.config.ts", "src/App.tsx", "src/main.tsx", "src/index.css", "src/lib/api.ts", "src/types/menu.ts", "src/types.ts", "src/vite-env.d.ts", "src/styles/tokens.css", "src/theme/colors.ts"])(
    "lets the orchestrator write %s before delegation", (path) => expect(isFoundationPath(path)).toBe(true));
  it.each(["src/pages/menu.tsx", "src/components/nav.tsx", "src/data/site.ts", "src", "src/lib"])(
    "keeps %s for a worker", (path) => expect(isFoundationPath(path)).toBe(false));
});

