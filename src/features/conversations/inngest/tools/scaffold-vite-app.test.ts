import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { _id: string; name: string; type: "file" | "folder"; parentId?: string; content?: string; locked?: boolean };

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@/lib/convex-client", () => ({
  convex: {
    // A snapshot, like the real query: later lock changes don't reach it.
    query: vi.fn(async () => db.rows.map((row) => ({ ...row }))),
    mutation: vi.fn(
      async (_ref: unknown, args: { name?: string; parentId?: string; files?: Row[] }) => {
        const insert = (row: Omit<Row, "_id">) => {
          const _id = `id${db.rows.length}`;
          db.rows.push({ ...row, _id });
          return _id;
        };
        const parentLocked = db.rows.find((row) => row._id === args.parentId)?.locked;
        if (!args.files) {
          // Like createFolder: a folder inside a locked one is refused with a FORBIDDEN error.
          if (parentLocked) {
            const { ConvexError } = await import("convex/values");
            throw new ConvexError({ code: "FORBIDDEN", message: `${args.name} is locked by the user.` });
          }
          return insert({ name: args.name!, type: "folder", parentId: args.parentId });
        }
        // Like createFiles: a write into a locked folder is refused per file, with no id.
        return args.files.map((file) => {
          if (parentLocked) return { name: file.name, fileId: "", error: `${file.name} is locked by the user.` };
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

import { convex } from "@/lib/convex-client";
import { toolResultError } from "@/features/conversations/agent-steps";
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
    expect(result).toContain("tsconfig.app.json");
    expect(result).toContain("src/components/error-boundary.tsx");
    expect(result).not.toMatch(/\bid\d+/);
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
    expect(result).toContain("Kept existing: src/App.tsx.");
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

  it("ships the form stack and pre-bundles only its own libraries", () => {
    const read = (path: string) => VITE_REACT_STARTER.find((file) => file.path === path)!.content;
    const { dependencies } = JSON.parse(read("package.json"));

    // The agent hand-wrote a zod resolver when @hookform/resolvers was missing.
    expect(dependencies).toMatchObject({
      "react-hook-form": KNOWN_GOOD_VERSIONS["react-hook-form"],
      "@hookform/resolvers": KNOWN_GOOD_VERSIONS["@hookform/resolvers"],
      zod: KNOWN_GOOD_VERSIONS.zod,
    });
    const include = read("vite.config.ts").match(/include: \[([^\]]*)\]/)![1];
    const packages = [...include.matchAll(/"([^"]+)"/g)].map(([, id]) => id);
    expect(packages).toContain("@hookform/resolvers/zod");
    // An id that isn't installed only makes Vite warn, so every one must be a dependency.
    for (const id of packages) {
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      expect(dependencies, id).toHaveProperty([name]);
    }
  });

  it("mounts an error boundary and a router around App (#335)", () => {
    const tool = createScaffoldViteAppTool({ projectId: "p" as never, internalKey: "k" });
    const read = (path: string) => VITE_REACT_STARTER.find((file) => file.path === path)!.content;

    expect(JSON.parse(read("package.json")).dependencies["react-router-dom"]).toBe(
      KNOWN_GOOD_VERSIONS["react-router-dom"],
    );
    expect(read("src/main.tsx")).toContain(
      "<ErrorBoundary>\n      <BrowserRouter>\n        <App />\n      </BrowserRouter>\n    </ErrorBoundary>",
    );
    expect(read("src/App.tsx")).toContain('<Route path="/" element={<Home />} />');
    const boundary = read("src/components/error-boundary.tsx");
    expect(boundary).toContain("static getDerivedStateFromError");
    expect(boundary).toContain("import.meta.env.DEV && componentStack");
    expect(boundary).toContain("window.location.reload()");
    expect(boundary).toContain('<a\n              href="/"');
    // Reload and Go home are touch targets: at least 44px (min-h-11), not h-9.
    expect(boundary.match(/inline-flex min-h-11 min-w-11 items-center/g)).toHaveLength(2);
    expect(boundary).not.toContain("h-9");
    // A flag, so `throw null` / `throw undefined` still show the card.
    expect(boundary).toContain("return { hasError: true, error };");
    expect(boundary).toContain("if (!hasError) return this.props.children;");
    expect(tool.description).toContain("Don't add another <BrowserRouter>.");
  });
});

describe("scaffoldViteApp and locks (#307)", () => {
  it("names locked files as locked, not kept, and makes no folder inside a locked one", async () => {
    db.rows = [
      { _id: "src", name: "src", type: "folder", locked: true },
      { _id: "pkg", name: "package.json", type: "file", content: "{}", locked: true },
    ];

    const result = await scaffold();

    const written = paths().map((file) => file.path);
    expect(written.filter((path) => path.startsWith("src/"))).toEqual([]);
    expect(db.rows.filter((row) => row.type === "folder").map((row) => row.name)).toEqual(["src"]);
    expect(db.rows.find((row) => row._id === "pkg")?.content).toBe("{}");
    expect(result).not.toContain("Kept existing");
    expect(result).toMatch(/Not written, locked by the user: .*package\.json.*src\/main\.tsx/);
  });
});

describe("scaffoldViteApp and an incomplete starter (#548)", () => {
  const isError = (result: unknown) => toolResultError({ data: result }) !== undefined;

  it("holds back the root files and reports an error when a lock blocks an entry file", async () => {
    db.rows = [{ _id: "src", name: "src", type: "folder", locked: true }];

    const result = await scaffold();

    const written = paths().map((file) => file.path);
    // package.json boots the preview and marks it ready, so it must not land without src/.
    expect(written).not.toContain("package.json");
    expect(written).not.toContain("vite.config.ts");
    expect(written).toEqual([]);
    expect(isError(result)).toBe(true);
    expect(result).toMatch(/^Error: Incomplete scaffold/);
    expect(result).toMatch(/Not written, locked by the user: .*src\/main\.tsx/);
    expect(result).not.toContain("Scaffolded");
  });

  it("names writes refused by a lock taken after the snapshot as locked, not kept", async () => {
    db.rows = [{ _id: "src", name: "src", type: "folder", locked: true }];
    vi.mocked(convex.query).mockResolvedValueOnce([{ _id: "src", name: "src", type: "folder" }] as never);

    const result = await scaffold();

    expect(paths().map((file) => file.path)).not.toContain("package.json");
    expect(result).not.toContain("Kept existing");
    expect(isError(result)).toBe(true);
    expect(result).toMatch(/Not written, locked by the user: .*src\/main\.tsx/);
    // src/lib can't be created inside the now-locked src: named, not lost in a thrown error.
    expect(result).toMatch(/Not written, locked by the user: .*src\/lib\/utils\.ts/);
    expect(result).not.toMatch(/Created: .*src\/main\.tsx/);
  });

  it("reports an error when the root files are all locked and a lock blocks an entry file", async () => {
    const root = VITE_REACT_STARTER.filter((file) => !file.path.includes("/"));
    db.rows = [
      { _id: "src", name: "src", type: "folder", locked: true },
      ...root.map((file, i) => ({ _id: `root${i}`, name: file.path, type: "file" as const, content: "mine", locked: true })),
    ];

    const result = await scaffold();

    expect(isError(result)).toBe(true);
    expect(result).not.toContain("Scaffolded");
    expect(result).toMatch(/Not written, locked by the user: .*src\/main\.tsx/);
  });

  it("still succeeds when only existing files are locked", async () => {
    db.rows = [
      { _id: "src", name: "src", type: "folder" },
      { _id: "app", name: "App.tsx", type: "file", parentId: "src", content: "mine", locked: true },
    ];

    const result = await scaffold();

    expect(isError(result)).toBe(false);
    expect(paths().map((file) => file.path)).toContain("package.json");
    expect(result).toContain("Not written, locked by the user: src/App.tsx.");
  });
});
