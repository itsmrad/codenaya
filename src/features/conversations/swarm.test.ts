import { createTool } from "@inngest/agent-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { guardOwnedPaths } from "./inngest/lib/ownership-guard";
import { ownsPath, validatePlan } from "./swarm";

const task = (id: string, ownedPaths: string[]) => ({ id, title: id, brief: `Build ${id}.`, ownedPaths });

describe("validatePlan", () => {
  it("accepts 2-4 tasks owning disjoint files and folders under src/, normalised", () => {
    const plan = { tasks: [task("nav", ["src/components/nav/"]), task("hero", ["./src/components/hero.tsx"])] };
    expect(validatePlan(plan)).toEqual({
      tasks: [task("nav", ["src/components/nav"]), task("hero", ["src/components/hero.tsx"])],
    });
  });

  it("refuses too few or too many tasks", () => {
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

  it("refuses shared files, folders holding one, and outside, absolute or parent paths", () => {
    for (const path of ["src/App.tsx", "src/lib", "src/lib/", "src", "src/", "src/index.css", "package.json", "/src/x.ts", "src/../x.ts", "public/x.png", "src//x.ts"]) {
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

  it("runs owned writes and leaves reads unrestricted", async () => {
    handler.mockClear();
    expect(await call("writeFiles", { files: [{ path: "src/pages/a.tsx" }] })).toBe("ok");
    expect(await call("deleteFiles", { paths: ["src/pages/old/"] })).toBe("ok");
    expect(await call("readFiles", { paths: ["src/App.tsx"] })).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
