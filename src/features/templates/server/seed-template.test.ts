import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/convex-client", () => ({ convex: { mutation } }));

import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import { getTemplateSeedFiles } from "../seed-files";
import { STARTER_TEMPLATES } from "../templates";
import { seedTemplateFiles } from "./seed-template";

describe("seedTemplateFiles", () => {
  it("creates each folder under its parent, then writes every seed file into its folder", async () => {
    mutation.mockImplementation(async (_ref, args) => `id:${args.name}`);
    const template = STARTER_TEMPLATES[0];

    await seedTemplateFiles({ internalKey: "key", projectId: "p1" as never, template });

    const calls = mutation.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);
    const folders = calls.filter(([name]) => name === "system:createFolder");
    const batches = calls.filter(([name]) => name === "system:createFiles");

    // The Vite starter nests src/lib, so the parent link is exercised.
    expect(folders.map(([, a]) => [a.name, a.parentId])).toEqual(
      expect.arrayContaining([
        ["src", undefined],
        ["lib", "id:src"],
      ])
    );
    // Every folder is created before any file is written into it.
    expect(calls.findIndex(([name]) => name === "system:createFiles")).toBe(folders.length);

    const written = batches.flatMap(([, a]) => a.files.map((f: { name: string }) => [a.parentId, f.name]));
    expect(written).toHaveLength(getTemplateSeedFiles(template).length);
    expect(written).toContainEqual([undefined, "package.json"]);
    expect(written).toContainEqual(["id:src", "App.tsx"]);
    expect(batches.every(([, a]) => a.internalKey === "key" && a.projectId === "p1")).toBe(true);
  });

  it("seeds the plain Vite starter when there is no template (#338)", async () => {
    mutation.mockReset();
    mutation.mockImplementation(async (_ref, args) => `id:${args.name}`);

    await seedTemplateFiles({ internalKey: "key", projectId: "p1" as never });

    const written = mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === "system:createFiles")
      .flatMap(([, a]) => a.files);
    expect(written).toHaveLength(VITE_REACT_STARTER.length);
    expect(written).toContainEqual({
      name: "package.json",
      content: VITE_REACT_STARTER.find((f) => f.path === "package.json")!.content,
    });
  });
});
