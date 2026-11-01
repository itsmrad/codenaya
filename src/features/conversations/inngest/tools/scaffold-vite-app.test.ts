import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { _id: string; name: string; type: "file" | "folder"; parentId?: string; content?: string };

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@/lib/convex-client", () => ({
  convex: {
    query: vi.fn(async () => db.rows),
    mutation: vi.fn(
      async (_ref: unknown, args: { name?: string; parentId?: string; files?: Row[] }) => {
        const insert = (row: Omit<Row, "_id">) => {
          const _id = `id${db.rows.length}`;
          db.rows.push({ ...row, _id });
          return _id;
        };
        if (!args.files) return insert({ name: args.name!, type: "folder", parentId: args.parentId });
        return args.files.map((file) => {
          const existing = db.rows.find(
            (row) => row.name === file.name && row.parentId === args.parentId,
          );
          return existing
            ? { name: file.name, fileId: existing._id, error: "File already exists" }
            : { name: file.name, fileId: insert({ ...file, type: "file", parentId: args.parentId }) };
        });
      },
    ),
  },
}));

import { missingReferencedFiles } from "@/features/sandbox-preview/utils/missing-references";

import { KNOWN_GOOD_VERSIONS } from "../known-good-versions";
import { VITE_REACT_STARTER } from "../vite-starter";
import { createScaffoldViteAppTool } from "./scaffold-vite-app";

const scaffold = () =>
  createScaffoldViteAppTool({ projectId: "p" as never, internalKey: "k" }).handler({}, {
    step: { run: (_id: string, fn: () => unknown) => fn() },
  } as never);

const paths = () => {
  const byId = new Map(db.rows.map((row) => [row._id, row]));
  const pathOf = (row: Row): string =>
    row.parentId ? `${pathOf(byId.get(row.parentId)!)}/${row.name}` : row.name;
  return db.rows.filter((row) => row.type === "file").map((row) => ({ path: pathOf(row), content: row.content! }));
};

describe("scaffoldViteApp tool", () => {
  beforeEach(() => {
    db.rows = [];
  });

  it("writes the whole starter, folders included, into an empty project", async () => {
    const result = await scaffold();

    expect(paths().map((file) => file.path).sort()).toEqual(
      VITE_REACT_STARTER.map((file) => file.path).sort(),
    );
    expect(missingReferencedFiles(paths())).toEqual([]);
    expect(result).toContain("tsconfig.app.json (id");
    expect(result).toMatch(/Folders: src \(id\d+\), src\/lib \(id\d+\)/);
  });

  it("writes package.json after every file outside the root", async () => {
    await scaffold();

    const files = db.rows.filter((row) => row.type === "file");
    const packageJson = files.findIndex((row) => row.name === "package.json");
    const lastNested = files.findLastIndex((row) => row.parentId !== undefined);
    expect(packageJson).toBeGreaterThan(lastNested);
  });

  it("keeps files and reuses folders that already exist", async () => {
    db.rows = [
      { _id: "src", name: "src", type: "folder" },
      { _id: "app", name: "App.tsx", type: "file", parentId: "src", content: "mine" },
    ];

    const result = await scaffold();

    expect(db.rows.filter((row) => row.name === "src")).toHaveLength(1);
    expect(db.rows.find((row) => row._id === "app")?.content).toBe("mine");
    expect(result).toContain("Kept existing: src/App.tsx (app).");
  });

  it("writes a React 19 + Tailwind v4 starter with no v3 leftovers (#332)", () => {
    const tool = createScaffoldViteAppTool({ projectId: "p" as never, internalKey: "k" });
    const read = (path: string) => VITE_REACT_STARTER.find((file) => file.path === path)!.content;
    const pkg = JSON.parse(read("package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // #331: every starter dependency comes from the known-good manifest.
    for (const [name, range] of Object.entries(deps)) {
      expect(range, name).toBe(KNOWN_GOOD_VERSIONS[name as keyof typeof KNOWN_GOOD_VERSIONS]);
    }
    expect(deps).toMatchObject({
      react: expect.stringMatching(/^\^19\./),
      "react-dom": deps.react,
      "@types/react": expect.stringMatching(/^\^19\./),
      tailwindcss: expect.stringMatching(/^\^4\./),
      "@tailwindcss/vite": deps.tailwindcss,
      "tw-animate-css": expect.any(String),
      "lucide-react": expect.stringMatching(/^\^1\./),
      "tailwind-merge": expect.stringMatching(/^\^3\./),
    });
    for (const name of ["tailwindcss-animate", "postcss", "autoprefixer"]) {
      expect(deps).not.toHaveProperty(name);
    }
    expect(read("vite.config.ts")).toContain("plugins: [react(), tailwindcss()]");
    expect(read("src/index.css")).toMatch(/^@import "tailwindcss";\n@import "tw-animate-css";/);
    expect(read("src/index.css")).toContain("--color-background: var(--background);");
    expect(JSON.parse(read("components.json")).tailwind.config).toBe("");

    const everything = [
      tool.description,
      ...VITE_REACT_STARTER.map((file) => `${file.path}\n${file.content}`),
    ].join("\n");
    for (const stale of ["tailwind.config", "postcss.config", "tailwindcss-animate", "@tailwind ", "hsl(var("]) {
      expect(everything).not.toContain(stale);
    }
  });
});
