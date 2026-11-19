import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), connect: vi.fn() }));
const mocks = vi.hoisted(() => ({ query: vi.fn(), resolveEnv: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: e2b.create, list: e2b.list, connect: e2b.connect },
}));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
vi.mock("@/features/integrations/server/env/resolve-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/integrations/server/env/resolve-env")>()),
  resolveProjectEnv: mocks.resolveEnv,
}));

import { CommandExitError, type CommandResult, type Sandbox as E2bSandbox, SandboxError, TimeoutError } from "e2b";
import { getFunctionName } from "convex/server";

import { BOOT_INSTALL_ENVS, DEV_COMMAND_ENV, DEV_START_COMMAND, READ_DEV_PGID_COMMAND, PROXY_TARGET_ENV, killProjectNodesCommand, killTreeCommand } from "@/features/sandbox-preview/server/dev-server";
import { createE2bProvider, fromE2bSandbox } from "@/features/sandbox-preview/server/provider/e2b";

import { VITE_REACT_STARTER } from "../vite-starter";
import { REDACTION_UNAVAILABLE_NOTICE } from "@/features/integrations/server/env/stream-redactor";

import {
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  STATIC_CHECKS_PASSED,
} from "../../agent-steps";
import { START_BUILD_ERROR, START_TYPE_ERROR } from "./start-build-output.fixture";
import { buildCommand, checkProjectBuild, createCheckBuildTool, trimBuildOutput, warmSlow } from "./check-build";
import { brokenImagesWarning } from "./remote-images";
import {
  NEXT16_MODULE_NOT_FOUND,
  NEXT16_PRERENDER_ERROR,
  NEXT16_SYNTAX_ERROR,
  NEXT16_TYPE_ERROR,
  NEXT_MODULE_NOT_FOUND,
  NEXT_PRERENDER_ERROR,
  NEXT_TYPE_ERROR,
} from "./next-build-output.fixture";

const starter = () => VITE_REACT_STARTER.map((file) => ({ ...file }));
const check = (files = starter(), apiKey: string | null = "e2b_key") =>
  checkProjectBuild({
    files,
    paths: new Set(files.map((file) => file.path)),
    provider: apiKey ? createE2bProvider(apiKey) : undefined,
  });

/** The structured lines `unfinished` logs, parsed. */
const unfinishedLogs = () =>
  vi.mocked(console.error).mock.calls
    .filter(([label]) => label === "[check-build] unfinished")
    .map(([, line]) => JSON.parse(line as string));

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

type Proc = { cmd: string; args: string[]; pid?: number; envs?: Record<string, string>; cwd?: string };

/** A sandbox whose commands get `respond`'s answer: a result, or an error to throw. */
const sandboxWith = (respond: (command: string) => Answer | undefined, processes: Proc[] = []) => ({
    files: { makeDir: vi.fn(async () => true), write: vi.fn(async () => ({})) },
    commands: {
      run: vi.fn<(command: string, opts?: object) => Promise<CommandResult>>(async (command) => {
        const answer = respond(command) ?? { exitCode: 0 };
        if (answer instanceof Error) throw answer;
        const result = { stdout: "", stderr: "", ...answer };
        if (result.exitCode !== 0) throw new CommandExitError(result);
        return result;
      }),
      list: vi.fn<(opts?: { requestTimeoutMs?: number }) => Promise<Proc[]>>(async () => processes),
    },
    kill: vi.fn(async () => {}),
});

/** The throwaway sandbox a cold check creates; its commands answer in order. */
const fakeSandbox = (...answers: Answer[]) => {
  const sandbox = sandboxWith(() => answers.shift());
  e2b.create.mockResolvedValue(sandbox);
  return sandbox;
};

beforeEach(() => {
  vi.restoreAllMocks();
  warmSlow.clear();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("trimBuildOutput", () => {
  it("strips colour codes and sandbox paths, and drops repeated and blank lines", () => {
    const output = [
      "\u001b[96m/home/user/app/src/App.tsx\u001b[0m(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "",
      "\u001b[96m/home/user/app/src/App.tsx\u001b[0m(3,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "Found 1 error.   ",
    ].join("\n");
    expect(trimBuildOutput(output)).toBe(
      "src/App.tsx(3,7): error TS2322: Type 'number' is not assignable to type 'string'.\nFound 1 error.",
    );
  });

  it("keeps the first 40 lines and counts the rest", () => {
    const output = Array.from({ length: 45 }, (_, i) => `error ${i}`).join("\n");
    const lines = trimBuildOutput(output).split("\n");
    expect(lines).toHaveLength(41);
    expect(lines[39]).toBe("error 39");
    expect(lines[40]).toBe("… 5 more line(s)");
  });
});

/** A minimal Next.js App Router project. */
const nextApp = () => [
  {
    path: "package.json",
    content: JSON.stringify({
      name: "app",
      private: true,
      scripts: { dev: "next dev", build: "next build" },
      dependencies: { next: "15.5.4", react: "19.1.0", "react-dom": "19.1.0" },
      devDependencies: { typescript: "^5", "@types/react": "^19" },
    }),
  },
  { path: "next.config.ts", content: "const nextConfig = {};\nexport default nextConfig;\n" },
  { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { strict: true, jsx: "preserve" } }) },
  {
    path: "src/app/layout.tsx",
    content: "export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang=\"en\"><body>{children}</body></html>;\n}\n",
  },
  { path: "src/app/page.tsx", content: "export default function Page() {\n  return <h1>Hello</h1>;\n}\n" },
];

describe("trimBuildOutput for Next.js", () => {
  const output = ({ stdout, stderr }: { stdout: string; stderr: string }) => `${stderr}\n${stdout}`;

  it("keeps a type error with its location and drops the build progress", () => {
    const trimmed = trimBuildOutput(output(NEXT_TYPE_ERROR), "/home/user/app", "next");
    expect(trimmed.split("\n").slice(0, 3)).toEqual([
      "Failed to compile.",
      "./src/app/page.tsx:12:3",
      "Type error: Type 'number' is not assignable to type 'string'.",
    ]);
    expect(trimmed).not.toMatch(/Next\.js 15|Creating an optimized|Compiled successfully|Linting and checking/);
  });

  it("keeps a missing module with its location", () => {
    const trimmed = trimBuildOutput(output(NEXT_MODULE_NOT_FOUND), "/home/user/app", "next");
    expect(trimmed.split("\n").slice(0, 3)).toEqual([
      "Failed to compile.",
      "./src/app/page.tsx:3:1",
      "Module not found: Can't resolve '@/components/Hero'",
    ]);
  });

  it("starts a prerender failure at its error, without the sandbox's paths", () => {
    const trimmed = trimBuildOutput(output(NEXT_PRERENDER_ERROR), "/home/user/app", "next");
    expect(trimmed.split("\n").slice(0, 2)).toEqual([
      'Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error',
      "Error: STRIPE_SECRET_KEY is not set",
    ]);
    expect(trimmed).not.toContain("/home/user/app/");
    expect(trimmed).not.toMatch(/Collecting page data|Generating static pages/);
  });

  it.each([
    ["type error", NEXT16_TYPE_ERROR, ["Failed to type check.", "src/app/page.tsx(8,13): error TS2322: Type 'number' is not assignable to type 'string'."]],
    ["missing module", NEXT16_MODULE_NOT_FOUND, ["> Build error occurred", "Error: Turbopack build failed with 1 error:", "./src/app/page.tsx:3:1", "Error: Module not found: Can't resolve '@/components/Hero'"]],
    ["syntax error", NEXT16_SYNTAX_ERROR, ["> Build error occurred", "Error: Turbopack build failed with 1 error:", "./src/app/page.tsx:6:3", "Error: Expected ',', got ';'"]],
    ["prerender failure", NEXT16_PRERENDER_ERROR, ['Error occurred prerendering page "/". Read more: https://nextjs.org/docs/messages/prerender-error', "Error: STRIPE_SECRET_KEY is not set", "    at <unknown> (src/app/page.tsx:2:45)"]],
  ])("keeps a Next 16 (Turbopack) %s first and drops the build progress", (_, fixture, head) => {
    const trimmed = trimBuildOutput(output(fixture), "/home/user/app", "next");
    expect(trimmed.split("\n").slice(0, head.length)).toEqual(head);
    expect(trimmed).not.toMatch(/Next\.js 16|next\.config\.ts took|Creating an optimized|Compiled successfully|TypeScript|Collecting page data|Generating static pages/);
  });

  it("puts errors printed after the route table first and drops the table and telemetry notice", () => {
    const stdout = [
      "Attention: Next.js now collects completely anonymous telemetry regarding usage.",
      "https://nextjs.org/telemetry",
      "Route (app)                                 Size  First Load JS",
      "┌ ○ /                                      5.4 kB         120 kB",
      "└ ○ /_not-found                              993 B         103 kB",
      "+ First Load JS shared by all             102 kB",
      "○  (Static)  prerendered as static content",
      "build log line",
      "Failed to compile.",
      "./src/app/about/page.tsx:4:10",
      "Type error: Cannot find name 'foo'.",
    ].join("\n");
    expect(trimBuildOutput(stdout, "/home/user/app", "next")).toBe(
      "Failed to compile.\n./src/app/about/page.tsx:4:10\nType error: Cannot find name 'foo'.\nbuild log line",
    );
  });

  it("leaves Vite output in its order", () => {
    expect(trimBuildOutput("✓ 31 modules transformed.\nerror during build:", "/home/user/app")).toBe(
      "✓ 31 modules transformed.\nerror during build:",
    );
  });
});

describe("trimBuildOutput for TanStack Start", () => {
  const output = ({ stdout, stderr }: { stdout: string; stderr: string }) => `${stderr}\n${stdout}`;

  it("starts at the tsc error after a passing build and drops both builds' progress", () => {
    expect(trimBuildOutput(output(START_TYPE_ERROR), "/home/user/app", "tanstack-start")).toBe(
      "src/routes/index.tsx(12,17): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
  });

  it("keeps Vite's failure with its location and drops the progress", () => {
    const trimmed = trimBuildOutput(output(START_BUILD_ERROR), "/home/user/app", "tanstack-start");
    expect(trimmed.split("\n").slice(0, 2)).toEqual([
      "error during build:",
      '[vite]: Rollup failed to resolve import "@/components/Hero" from "src/routes/index.tsx".',
    ]);
    expect(trimmed).not.toMatch(/vite v7|transforming|modules transformed/);
  });
});

describe("buildCommand", () => {
  it("builds TanStack Start before type checking, since the build generates its route tree", () => {
    expect(buildCommand("tanstack-start", new Set(["package.json", "tsconfig.json"]))).toBe(
      "npx vite build && npx tsc --noEmit",
    );
  });

  it("runs next build alone for Next.js, without telemetry", () => {
    expect(buildCommand("next", new Set(["package.json", "tsconfig.json"]))).toBe(
      "NEXT_TELEMETRY_DISABLED=1 npx next build",
    );
  });

  it("type checks before vite build when there is a tsconfig", () => {
    expect(buildCommand("vite", new Set(["tsconfig.json"]))).toBe("npx tsc --noEmit -p tsconfig.json && npx vite build");
    expect(buildCommand("vite", new Set())).toBe("npx vite build");
  });
});

describe("checkProjectBuild", () => {
  it("returns static failures without starting a sandbox", async () => {
    const files = [
      ...starter(),
      { path: "src/pages/Home.tsx", content: 'import { Header } from "../components/Header";\n' },
    ];
    const result = await check(files);
    expect(result).toMatch(/^Error: Static checks failed:/);
    expect(result).toContain("../components/Header (imported by src/pages/Home.tsx)");
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("uses public upload paths when checking internal links", async () => {
    const files = [...starter(), {
      path: "src/Links.tsx",
      content: '<><Route path="/" /><a href="/docs/" /></>',
    }];
    expect(await check(files, null)).toContain("Link to /docs/ has no route");
    const result = await checkProjectBuild({
      files,
      paths: new Set([...files.map((file) => file.path), "public/docs/upload.pdf"]),
    });
    expect(result.split("\n")[0]).toBe(STATIC_CHECKS_PASSED);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("reports named-export and Tailwind heuristics as advisory", async () => {
    const sandbox = fakeSandbox();
    const result = await check([
      ...starter(),
      { path: "src/ui.ts", content: "export const Button = 1;" },
      { path: "src/Bad.tsx", content: 'import { Dialog } from "./ui";' },
      { path: "src/drift.css", content: "@tailwind utilities;" },
    ]);
    expect(result).toContain("no such export");
    expect(result).toContain("replace v3 @tailwind");
    expect(result).toMatch(/^Build verified/);
    expect(sandbox.commands.run).toHaveBeenCalledTimes(2);
  });

  it.each(["next", "oversized", "malformed", "many-files"])("retains unconditional import/package gates for %s snapshots", async (kind) => {
    const files = starter();
    const manifest = files.find((f) => f.path === "package.json")!;
    if (kind === "next") {
      const pkg = JSON.parse(manifest.content);
      pkg.dependencies.next = "15";
      manifest.content = JSON.stringify(pkg);
    }
    if (kind === "malformed") manifest.content = "{";
    if (kind === "oversized") files.push({ path: "large.ts", content: " ".repeat(100_001) });
    if (kind === "many-files") for (let i = 0; i < 501; i++) files.push({ path: `empty${i}.ts`, content: "" });
    files.push({ path: "broken.ts", content: 'import x from "./missing"; import y from "undeclared-package";' });
    const result = await check(files);
    expect(result).toMatch(/^Error: Static checks failed:/);
    expect(result).toContain("./missing");
    if (kind !== "malformed") expect(result).toContain("undeclared-package");
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("falls back to the static checks without an E2B key", async () => {
    const result = await check(starter(), null);
    expect(result.split("\n")[0]).toBe(STATIC_CHECKS_PASSED);
    expect(result).toContain("No build sandbox is configured");
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("builds in a given sandbox's own directory, without a key, lookup, new sandbox or kill", async () => {
    const sandbox = sandboxWith(() => undefined);
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
    });

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    const commands = sandbox.commands.run.mock.calls.map(([command, opts]) => [command, (opts as { cwd?: string })?.cwd]);
    const dir = commands[0][1]!;
    expect(dir).toMatch(/^\/home\/user\/check-build-[\w-]+$/);
    expect(commands.at(-1)).toEqual([`rm -rf ${dir}`, undefined]);
    expect(sandbox.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
    expect(e2b.list).not.toHaveBeenCalled();
    expect(e2b.connect).not.toHaveBeenCalled();
  });

  describe("remote images", () => {
    const DEAD = "https://images.unsplash.com/photo-1579584425555-c3ce17fd4399?w=800";
    const withImage = () => [
      ...starter().filter((file) => file.path !== "src/App.tsx"),
      { path: "src/App.tsx", content: `export default function App() { return <img src="${DEAD}" alt="Sushi" />; }` },
    ];
    const checkWithProbe = (stdout: string) => {
      const sandbox = sandboxWith((command) => (command.startsWith("node -e") ? { exitCode: 0, stdout } : undefined));
      const files = withImage();
      const result = checkProjectBuild({
        files,
        paths: new Set(files.map((file) => file.path)),
        sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
      });
      return { sandbox, result };
    };

    it("appends a dead image to a passing build as a warning, not an error", async () => {
      const { sandbox, result } = checkWithProbe(JSON.stringify([[DEAD, 404, "text/html"]]));
      const text = await result;
      expect(text.split("\n")[0]).toBe(BUILD_VERIFIED);
      expect(text.endsWith(brokenImagesWarning([`src/App.tsx: ${DEAD} (HTTP 404)`]))).toBe(true);
      const commands = sandbox.commands.run.mock.calls.map(([command]) => command);
      expect(commands.some((command) => command.includes("vite build"))).toBe(true);
    });

    it("passes when the images load or the probe is inconclusive", async () => {
      expect((await checkWithProbe(JSON.stringify([[DEAD, 200, "image/jpeg"]])).result).split("\n")[0]).toBe(BUILD_VERIFIED);
      expect((await checkWithProbe(JSON.stringify([[DEAD, 0, ""]])).result).split("\n")[0]).toBe(BUILD_VERIFIED);
      expect((await checkWithProbe("not json").result).split("\n")[0]).toBe(BUILD_VERIFIED);
    });
  });

  it("times out an in-flight worker check before the 9-minute invoke deadline (#649)", async () => {
    vi.useFakeTimers();
    try {
      const invokedAt = Date.now() - 6 * 60_000;
      const deadline = invokedAt + 8 * 60_000;
      const sandbox = sandboxWith(() => undefined);
      sandbox.commands.run.mockImplementation(async (command, options) => {
        if (command.startsWith("npm install")) vi.setSystemTime(Date.now() + 20_000);
        if (command.includes("vite build")) {
          const opts = options as { timeoutMs: number; requestTimeoutMs: number };
          expect(opts.timeoutMs).toBe(100_000);
          expect(opts.requestTimeoutMs).toBe(opts.timeoutMs);
          return new Promise((_, reject) => setTimeout(() => reject(new TimeoutError("Command timed out")), opts.timeoutMs));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      const files = starter();
      const checking = checkProjectBuild({
        files,
        paths: new Set(files.map((file) => file.path)),
        sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
        sourceDir: "/home/user/app",
        deadline,
      });
      await vi.runAllTimersAsync();

      expect(await checking).toMatch(/^Error: The build check could not finish/);
      expect(Date.now()).toBe(deadline);
      expect(Date.now()).toBeLessThan(invokedAt + 9 * 60_000);
      expect(sandbox.commands.run.mock.calls.at(-1)?.[0]).toMatch(/^rm -rf \/home\/user\/check-build-/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("first copies sourceDir into the check directory, without node_modules, secret files or the top-level dist", async () => {
    const sandbox = sandboxWith((command) =>
      command.startsWith("find ") ? { exitCode: 0, stdout: "src/App.tsx\n.env\nsub/.ENV.local\n.env.example\n" } : undefined,
    );
    const files = starter();
    await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
      sourceDir: "/home/user/app",
    });

    const [copy, find, ...rest] = sandbox.commands.run.mock.calls.map(([command]) => command);
    const dir = (sandbox.commands.run.mock.calls[1][1] as { cwd: string }).cwd;
    expect(copy).toBe(
      `mkdir -p ${dir} && tar -C '/home/user/app' --exclude=node_modules --exclude=.git --exclude=./dist ` +
        `-cf - . | tar -C ${dir} -xf -`,
    );
    expect(find).toMatch(/^find \./);
    expect(rest.slice(0, 3)).toEqual([`rm -rf -- '${dir}/.env'`, `rm -rf -- '${dir}/sub/.ENV.local'`, expect.stringMatching(/^npm install/)]);
  });

  it("refuses snapshot paths that would leave a given sandbox's check directory", async () => {
    const sandbox = sandboxWith(() => undefined);
    const files = [...starter(), { path: "../outside.ts", content: "" }];
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
    });

    expect(result).toBe("Error: Static checks failed: Invalid project file path.");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("falls back to the static checks when the sandbox cannot start", async () => {
    e2b.create.mockRejectedValue(new Error("503 Service Unavailable"));
    const result = await check();
    expect(result.split("\n")[0]).toBe(STATIC_CHECKS_PASSED);
    expect(result).toContain("could not start");
  });

  it("skips the build for projects that are not Vite apps", async () => {
    const result = await check([{ path: "index.js", content: "console.log(1);\n" }]);
    expect(result.split("\n")[0]).toBe(BUILD_NOT_CHECKED);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("builds a Next.js project with next build", async () => {
    const sandbox = fakeSandbox({ exitCode: 0 }, { exitCode: 0 });
    const result = await check(nextApp());
    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    const commands = sandbox.commands.run.mock.calls.map((call) => (call as unknown[])[0]);
    expect(commands).toEqual([
      "npm install --prefer-offline --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error",
      "NEXT_TELEMETRY_DISABLED=1 npx next build",
    ]);
  });

  it("builds a Next.js project named only by its package.json dependency", async () => {
    const sandbox = fakeSandbox({ exitCode: 0 }, { exitCode: 0 });
    const result = await check(nextApp().filter(({ path }) => path !== "next.config.ts"));
    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(sandbox.commands.run.mock.calls[1][0]).toBe("NEXT_TELEMETRY_DISABLED=1 npx next build");
  });

  it("returns a Next.js type error first", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, ...NEXT_TYPE_ERROR });
    const result = await check(nextApp());
    expect(result).toMatch(
      /^Error: Build failed\. Fix these errors, then call checkBuild again:\nFailed to compile\.\n\.\/src\/app\/page\.tsx:12:3\nType error: /,
    );
  });

  it("leaves Next.js build output out of the sourceDir copy", async () => {
    const sandbox = sandboxWith(() => undefined);
    const files = nextApp();
    await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
      sourceDir: "/home/user/app",
    });
    const [copy] = sandbox.commands.run.mock.calls.map(([command]) => command);
    expect(copy).toContain("--exclude=./dist --exclude=./.next --exclude=./out --exclude=./next-env.d.ts -cf ");
  });

  it("leaves TanStack Start build output out of the sourceDir copy", async () => {
    const sandbox = sandboxWith(() => undefined);
    const files = [
      { path: "package.json", content: JSON.stringify({ dependencies: { "@tanstack/react-start": "1.0.0", vite: "7.0.0" } }) },
      { path: "vite.config.ts", content: "export default {};\n" },
    ];
    await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
      sourceDir: "/home/user/app",
    });
    const [copy] = sandbox.commands.run.mock.calls.map(([command]) => command);
    expect(copy).toContain("--exclude=./dist --exclude=./.output --exclude=./.tanstack --exclude=./.nitro --exclude=./.vinxi -cf ");
  });

  it("installs, type checks and builds, then kills the sandbox", async () => {
    const sandbox = fakeSandbox({ exitCode: 0 }, { exitCode: 0 });
    const result = await check();
    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(sandbox.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([{ path: "/home/user/app/src/App.tsx", data: expect.any(String) }]),
      { requestTimeoutMs: expect.any(Number) },
    );
    const commands = sandbox.commands.run.mock.calls.map((call) => (call as unknown[])[0]);
    expect(commands).toEqual([
      "npm install --prefer-offline --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error",
      "npx tsc --noEmit -p tsconfig.app.json && npx vite build",
    ]);
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("returns the trimmed compiler errors when the build fails", async () => {
    const sandbox = fakeSandbox(
      { exitCode: 0 },
      { exitCode: 2, stdout: "/home/user/app/src/App.tsx(3,7): error TS2322: Bad type.\n" },
    );
    const result = await check();
    expect(result).toBe(
      "Error: Build failed. Fix these errors, then call checkBuild again:\nsrc/App.tsx(3,7): error TS2322: Bad type.",
    );
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("reports a failed install", async () => {
    fakeSandbox({ exitCode: 1, stderr: "npm error 404 Not Found - left-pad-x" });
    const result = await check();
    expect(result).toMatch(/^Error: npm install failed/);
    expect(result).toContain("left-pad-x");
  });

  it.each([
    "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/react",
    "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/react failed",
    "npm error code ECONNRESET",
    "npm error code EAI_AGAIN",
    "npm error code ENOTFOUND",
    "npm error socket hang up",
  ])("reports an install the registry or network failed as unfinished, not a code error: %s", async (stderr) => {
    fakeSandbox({ exitCode: 1, stderr });
    const result = await check();
    expect(result).toMatch(/^Error: The build check could not finish \(npm could not reach the package registry\)/);
  });

  it("adds the known cause and fix for a matched error, even past the trimmed lines", async () => {
    const progress = Array.from({ length: 45 }, (_, i) => `transforming module ${i}`).join("\n");
    fakeSandbox(
      { exitCode: 0 },
      { exitCode: 1, stdout: `${progress}\n[vite]: Rollup failed to resolve import "react-router-dom" from "src/main.tsx".` },
    );
    const result = await check();
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain("… 6 more line(s)\n\nLikely cause (unresolved-import): ");
    expect(result).toContain("\nKnown fix: ");
  });

  it("reports a timeout as an unfinished check, not a code error, and still kills the sandbox", async () => {
    const sandbox = fakeSandbox(new TimeoutError("Command timed out"));
    const result = await check();
    expect(result).toMatch(/^Error: The build check could not finish \(Command timed out\)/);
    expect(result).toContain("not an error in the project's code");
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("logs which path an unfinished check took, its sandbox and the budget left", async () => {
    Object.assign(fakeSandbox(new TimeoutError("Command timed out")), { sandboxId: "sbx_cold" });
    await check();
    expect(unfinishedLogs()).toEqual([
      expect.objectContaining({ path: "cold", sandboxId: "sbx_cold", error: "SandboxTimeoutError", reason: "Command timed out" }),
    ]);
  });
});

const SECRET = "sk_live_SYNTHETIC_0123456789";

describe("checkProjectBuild redaction (#465)", () => {
  it("redacts the project's secrets from build errors", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: `Error: connect ECONNREFUSED postgres://app:${SECRET}@db` });
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      provider: createE2bProvider("e2b_key"),
      secrets: [SECRET],
    });
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain("postgres://app:[redacted]@db");
    expect(result).not.toContain(SECRET);
  });

  it("redacts a multi-line secret before the 40-line cap can cut it", async () => {
    const key = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICKEYMATERIAL",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const progress = Array.from({ length: 38 }, (_, i) => `transforming module ${i}`).join("\n");
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stdout: `${progress}\n${key}\nerror during build` });
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      provider: createE2bProvider("e2b_key"),
      secrets: [key],
    });
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("SYNTHETICKEYMATERIAL");
    expect(result).not.toContain("BEGIN PRIVATE KEY");
  });

  it.each([
    ["split by a colour code", `token=sk_live_SYNTHETIC_\u001b[0m0123456789`],
    ["printed with CRLF line endings", "-----BEGIN PRIVATE KEY-----\r\nMIIEvQSYNTHETICCRLFKEY\r\n-----END PRIVATE KEY-----"],
  ])("redacts a secret %s, which only trimming puts back together", async (_case, printed) => {
    const secret = printed.includes("PRIVATE")
      ? "-----BEGIN PRIVATE KEY-----\nMIIEvQSYNTHETICCRLFKEY\n-----END PRIVATE KEY-----"
      : SECRET;
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: printed });
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      provider: createE2bProvider("e2b_key"),
      secrets: [secret],
    });
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("SYNTHETIC");
  });

  it("redacts the project's secrets from an unfinished check", async () => {
    fakeSandbox(new TimeoutError(`Command timed out: ${SECRET}`));
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      provider: createE2bProvider("e2b_key"),
      secrets: [SECRET],
    });
    expect(result).toMatch(/^Error: The build check could not finish/);
    expect(result).not.toContain(SECRET);
    expect(JSON.stringify(unfinishedLogs())).not.toContain(SECRET);
  });
});

describe("checkProjectBuild redaction wiring", () => {
  const CANARY = "dummy-canary-check-build-0001";
  const encoded = [CANARY, Buffer.from(CANARY).toString("base64"), Buffer.from(CANARY).toString("hex")];
  const build = (secrets: readonly string[] | null, files = starter()) =>
    checkProjectBuild({ files, paths: new Set(files.map((file) => file.path)), provider: createE2bProvider("e2b_key"), secrets });

  it("masks a value printed raw, as base64 or as hex, in build errors", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: encoded.map((form, i) => `error ${i}: ${form}`).join("\n") });
    const result = await build([CANARY]);
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain("error 1: [redacted]");
    for (const form of encoded) expect(result).not.toContain(form);
  });

  it("masks an encoded value in an unfinished check's reason and its log", async () => {
    fakeSandbox(new TimeoutError(`Command timed out: ${encoded[1]}`));
    const result = await build([CANARY]);
    expect(result).toMatch(/^Error: The build check could not finish/);
    expect(JSON.stringify([result, unfinishedLogs()])).not.toContain(encoded[1]);
  });

  it("hides the output behind the notice, keeping the result's prefix, when the values are unknown", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: `vite.config.ts: ${CANARY}` });
    const result = await build(null);
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain(REDACTION_UNAVAILABLE_NOTICE);
    expect(result).not.toContain("vite.config.ts");
  });

  it("keeps the static-check prefix when a 3-character value occurs in it", async () => {
    const files = [...starter(), { path: "src/pages/Home.tsx", content: 'import { Chart } from "../components/Statistics";\n' }];
    expect(STATIC_CHECKS_FAILED).toContain("tic");
    const result = await build(["tic"], files);
    expect(result.startsWith(`${STATIC_CHECKS_FAILED}:`)).toBe(true);
    expect(result).toContain("../components/Statis[redacted]s");
  });

  it("redacts once, so a value inside the placeholder leaves it intact", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: "error: act now" });
    const result = await build(["act"]);
    expect(result).toContain("error: [redacted] now");
    expect(result).not.toContain("[red[redacted]");
  });

  it("masks a multi-line value whose lines trimming brings back together", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: "dummy-line-one\n\ndummy-line-two" });
    const result = await build(["dummy-line-one\ndummy-line-two"]);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("dummy-line-two");
  });
});

const DEV_SERVER: Proc = { cmd: "/bin/bash", args: ["-l", "-c", "npm run dev -- --host"] };
const installing = (command: string): Proc => ({ cmd: "/bin/bash", args: ["-l", "-c", command] });

describe("checkProjectBuild in the warm preview sandbox (#465)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const warmCheck = (files = starter(), secrets?: string[]) => {
    return checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      provider: createE2bProvider("e2b_key"),
      metadata: { projectId: "proj_1", purpose: "check-build" },
      preview: { projectId: "proj_1", ownerId: "user_1" },
      secrets,
    });
  };
  const listed = (...infos: Array<{ metadata?: Record<string, string>; minutesLeft?: number }>) =>
    e2b.list.mockReturnValue({
      nextItems: async () =>
        infos.map((info, i) => ({
          sandboxId: `sbx_warm_${i}`,
          metadata: info.metadata ?? { userId: "user_1", projectId: "proj_1" },
          endAt: new Date(Date.now() + (info.minutesLeft ?? 50) * 60_000),
        })),
    });
  /** The preview's sandbox, running its dev server. */
  const warmSandbox = (respond: (command: string) => Answer | undefined = () => undefined, processes = [DEV_SERVER]) => {
    const sandbox = sandboxWith(respond, processes);
    e2b.connect.mockResolvedValue(sandbox);
    return sandbox;
  };
  const commandsOf = (sandbox: ReturnType<typeof sandboxWith>) =>
    sandbox.commands.run.mock.calls.map((call) => call[0]);
  /** The cold fallback ran, and the preview was left running. */
  const expectCold = (result: string, warm?: ReturnType<typeof sandboxWith>) => {
    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.create).toHaveBeenCalledTimes(1);
    if (warm) expect(warm.kill).not.toHaveBeenCalled();
  };

  it("builds in its own directory of the owner's running preview, without killing it or creating a sandbox", async () => {
    listed({});
    const warm = warmSandbox();
    fakeSandbox();

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userId: "user_1", projectId: "proj_1" }, state: ["running"] },
      }),
    );
    // No longer than the time the sandbox already has left, so its timeout is unchanged.
    expect(e2b.connect).toHaveBeenCalledWith("sbx_warm_0", {
      apiKey: "e2b_key",
      timeoutMs: 300_000,
      requestTimeoutMs: 10_000,
    });
    const [stateBefore, copy, stateAfter, install, build, cleanup] = commandsOf(warm);
    expect(stateBefore).toMatch(/^stat /);
    expect(stateAfter).toBe(stateBefore);
    const dir = copy.match(/mkdir -p (\/home\/user\/check-build-\w+) && cp -a \/home\/user\/app\/node_modules /)?.[1];
    expect(dir).toBeDefined();
    expect(install).toMatch(/^npm install/);
    expect(build).toBe("npx tsc --noEmit -p tsconfig.app.json && npx vite build");
    expect(warm.commands.run.mock.calls[3][1]).toMatchObject({ cwd: dir });
    expect(cleanup).toBe(`rm -rf ${dir}`);
    // Awaited and bounded, not left running in the background.
    expect(warm.commands.run.mock.calls[5][1]).toEqual({ timeoutMs: 10_000, requestTimeoutMs: 10_000 });
    expect(warm.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([{ path: `${dir}/src/App.tsx`, data: expect.any(String) }]),
      { requestTimeoutMs: expect.any(Number) },
    );
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("builds a Next.js project in a new sandbox, never beside the preview's next dev", async () => {
    listed({});
    const cold = fakeSandbox();

    const result = await warmCheck(nextApp());

    expectCold(result);
    expect(e2b.list).not.toHaveBeenCalled();
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(commandsOf(cold)).toContain("NEXT_TELEMETRY_DISABLED=1 npx next build");
  });

  it("builds a TanStack Start project in a new sandbox, never beside the preview's dev server", async () => {
    listed({});
    const cold = fakeSandbox();
    const files = [
      { path: "package.json", content: JSON.stringify({ dependencies: { "@tanstack/react-start": "1.0.0", vite: "7.0.0" } }) },
      { path: "vite.config.ts", content: "export default {};\n" },
    ];

    const result = await warmCheck(files);

    expectCold(result);
    expect(e2b.list).not.toHaveBeenCalled();
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(commandsOf(cold)).toContain("npx vite build && npx tsc --noEmit");
    expect(cold.kill).toHaveBeenCalledTimes(1);
  });

  describe("the preview's dev server after a warm build", () => {
    const dev: Proc = { ...DEV_SERVER, pid: 12, envs: { [DEV_COMMAND_ENV]: "npm run dev -- --hostname 0.0.0.0" }, cwd: "/home/user/app" };
    const proxy: Proc = { cmd: "/bin/bash", args: ["-l", "-c", "node /home/user/e2b-proxy.js"], pid: 5, envs: { [PROXY_TARGET_ENV]: "3000" } };
    const afterBuild = (warm: ReturnType<typeof sandboxWith>) => {
      const commands = commandsOf(warm);
      return commands.slice(commands.indexOf("npx tsc --noEmit -p tsconfig.app.json && npx vite build") + 1);
    };

    it("starts the dev server again, the same way, when the build took its port down", async () => {
      listed({});
      const warm = warmSandbox(undefined, [dev, proxy]);

      const result = await warmCheck();

      expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
      const [cleanup, ...rest] = afterBuild(warm);
      expect(cleanup).toMatch(/^rm -rf \/home\/user\/check-build-/);
      expect(rest.slice(0, 3)).toEqual(Array(3).fill(expect.stringContaining("port:3000")));
      expect(rest.slice(3)).toEqual([READ_DEV_PGID_COMMAND, killTreeCommand(12), killProjectNodesCommand("/home/user/app"), DEV_START_COMMAND]);
      // Bounded like the rest of the cleanup, so a slow sandbox can't hold the step past its budget.
      expect(warm.commands.run.mock.calls.at(-2)?.[1]).toEqual({ timeoutMs: 10_000, requestTimeoutMs: 10_000 });
      expect(warm.commands.run.mock.calls.at(-1)?.[1]).toEqual({
        cwd: "/home/user/app", envs: dev.envs, background: true, timeoutMs: 0, requestTimeoutMs: 10_000,
      });
      expect(warm.kill).not.toHaveBeenCalled();
      expect(e2b.create).not.toHaveBeenCalled();
    });

    it("still builds warm when the dev server lookup fails", async () => {
      listed({});
      const warm = warmSandbox(undefined, [dev, proxy]);
      // The install checks before and after the copy, then the lookup before the build.
      warm.commands.list
        .mockResolvedValueOnce([dev, proxy])
        .mockResolvedValueOnce([dev, proxy])
        .mockRejectedValueOnce(new Error("envd hiccup"));

      const result = await warmCheck();

      expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
      expect(afterBuild(warm)).toEqual([expect.stringMatching(/^rm -rf /)]);
      expect(e2b.create).not.toHaveBeenCalled();
    });

    it("leaves a dev server whose port still answers alone", async () => {
      listed({});
      const warm = warmSandbox((command) => (command.includes('require("net")') ? { exitCode: 0, stdout: "open\n" } : undefined), [dev, proxy]);

      const result = await warmCheck();

      expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
      expect(afterBuild(warm)).toEqual([expect.stringMatching(/^rm -rf /), expect.stringContaining("port:3000")]);
    });
  });

  /** Builds, but imports an export App.tsx lacks: an advisory finding (#333). */
  const withAdvisory = (name: string) => [
    ...starter(),
    { path: "src/Extra.tsx", content: `import { ${name} } from "./App";\nexport const extra = ${name};\n` },
  ];

  it("keeps the advisory project checks on a passing build, warm and cold", async () => {
    listed({});
    warmSandbox();
    const warm = await warmCheck(withAdvisory("Nope"));
    expect(warm.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(warm).toContain("\nAdvisory project checks:\n- [export] src/Extra.tsx imports { Nope } from ./App");
    expect(e2b.create).not.toHaveBeenCalled();

    listed();
    fakeSandbox();
    const cold = await warmCheck(withAdvisory("Nope"));
    expect(cold.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(cold).toContain("[export] src/Extra.tsx imports { Nope } from ./App");
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("redacts the project's secrets from the advisory notes", async () => {
    listed();
    fakeSandbox();
    const result = await warmCheck(withAdvisory("SYNTHETIC_SECRET_NAME"), ["SYNTHETIC_SECRET_NAME"]);
    expect(result).toContain("imports { [redacted] } from ./App");
    expect(result).not.toContain("SYNTHETIC_SECRET_NAME");
  });

  it("reports build errors from the warm sandbox with its paths made relative", async () => {
    listed({});
    let dir = "";
    warmSandbox((command) => {
      if (command.startsWith("mkdir")) dir = command.split(" ")[2];
      return command.startsWith("npx tsc")
        ? { exitCode: 2, stdout: `${dir}/src/App.tsx(3,7): error TS2322: Bad type.\n` }
        : undefined;
    });

    const result = await warmCheck();

    expect(result).toBe(
      "Error: Build failed. Fix these errors, then call checkBuild again:\nsrc/App.tsx(3,7): error TS2322: Bad type.",
    );
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it.each([
    ["there is no running preview", () => listed()],
    ["the listed sandbox belongs to another user", () => listed({ metadata: { userId: "user_2", projectId: "proj_1" } })],
    ["the listed sandbox runs another project", () => listed({ metadata: { userId: "user_1", projectId: "proj_2" } })],
    ["the preview is about to expire", () => listed({ minutesLeft: 4 })],
  ])("uses a new sandbox when %s, without connecting", async (_case, arrange) => {
    arrange();
    const cold = fakeSandbox();

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(cold.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    "npm install --prefer-offline",
    "npm i react-router-dom",
    "npm ci",
    "pnpm add zod",
    "yarn install",
    "bun i",
  ])("uses a new sandbox when the preview still runs `%s` after the wait, and leaves the preview alone", async (command) => {
    vi.useFakeTimers();
    listed({});
    const warm = warmSandbox(undefined, [DEV_SERVER, installing(command)]);
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    expectCold(await result, warm);
    expect(commandsOf(warm).filter((run) => !run.startsWith("rm -rf"))).toEqual([]);
    // Polled every 2.5 s, the last one before 60 s.
    expect(warm.commands.list).toHaveBeenCalledTimes(24);
  });

  it("uses a new sandbox while the preview's tagged custom install still runs after the wait", async () => {
    vi.useFakeTimers();
    listed({});
    const warm = warmSandbox(undefined, [DEV_SERVER, { ...installing("bash setup.sh"), envs: BOOT_INSTALL_ENVS }]);
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    expectCold(await result, warm);
    expect(warm.commands.list).toHaveBeenCalledTimes(24);
  });

  it("waits for the preview's install to finish, then builds warm without a new sandbox", async () => {
    vi.useFakeTimers();
    listed({});
    const warm = warmSandbox();
    const npmInstall = [DEV_SERVER, installing("npm install --prefer-offline --no-audit --no-fund")];
    warm.commands.list.mockResolvedValueOnce(npmInstall).mockResolvedValueOnce(npmInstall).mockResolvedValueOnce(npmInstall);
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    expect((await result).split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(commandsOf(warm).some((run) => run.startsWith("npx tsc"))).toBe(true);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("never waits past 60 s for an install, even when the process list answers slowly", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    listed({});
    const warm = warmSandbox();
    // Each poll answers after 9 s, or times out first like the e2b client.
    warm.commands.list.mockImplementation(
      (opts) =>
        new Promise((resolve, reject) => {
          const timeoutMs = opts?.requestTimeoutMs ?? Infinity;
          if (timeoutMs < 9_000) setTimeout(() => reject(new TimeoutError("Request timed out")), timeoutMs);
          else setTimeout(() => resolve([DEV_SERVER, installing("npm install")]), 9_000);
        }),
    );
    const cold = fakeSandbox();
    let coldAt = 0;
    e2b.create.mockImplementation(async () => {
      coldAt = Date.now();
      return cold;
    });

    const result = warmCheck();
    await vi.runAllTimersAsync();

    expectCold(await result, warm);
    expect(coldAt - start).toBeLessThanOrEqual(60_000);
    expect(commandsOf(warm).some((run) => run.startsWith("mkdir"))).toBe(false);
  });

  it.each([
    new SandboxError("2: [unknown] The operation was aborted due to timeout"),
    new TimeoutError("[deadline_exceeded] Request timed out"),
  ])("keeps waiting warm after a process-list request timeout: %s", async (error) => {
    vi.useFakeTimers();
    listed({});
    const warm = warmSandbox();
    // The e2b client aborts a slow list at its request timeout and reports it as an unknown error.
    const slowAbort = (opts?: { requestTimeoutMs?: number }) =>
      new Promise<Proc[]>((_, reject) =>
        setTimeout(
          () => reject(error),
          opts?.requestTimeoutMs,
        ),
      );
    warm.commands.list
      .mockResolvedValueOnce([DEV_SERVER, installing("npm install")])
      .mockImplementationOnce(slowAbort);
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    expect((await result).split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(commandsOf(warm).some((run) => run.startsWith("npx tsc"))).toBe(true);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it.each([
    [new SandboxError("sandbox not found"), 0],
    [new SandboxError("sandbox not found"), 10_000],
    [new TimeoutError("This error is likely due to sandbox timeout"), 0],
    [new TimeoutError("This error is likely due to sandbox timeout"), 10_000],
  ])("uses a new sandbox when the preview is gone: %s after %i ms", async (error, delay) => {
    vi.useFakeTimers();
    listed({});
    const warm = warmSandbox();
    warm.commands.list.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(error), delay)));
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();
    expectCold(await result, warm);
    expect(warm.commands.list).toHaveBeenCalledTimes(1);
  });

  it.each([0, 200_000])("bounds repeated process-list timeouts after %i ms of the step budget", async (elapsed) => {
    vi.useFakeTimers();
    const start = Date.now();
    listed({});
    const warm = warmSandbox();
    e2b.connect.mockImplementation(async () => {
      vi.setSystemTime(start + elapsed);
      return warm;
    });
    const timeouts: number[] = [];
    warm.commands.list.mockImplementation((opts) => {
      const timeout = opts!.requestTimeoutMs!;
      timeouts.push(timeout);
      return new Promise((_, reject) => setTimeout(() => reject(new TimeoutError("Request timed out")), timeout));
    });
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    if (elapsed === 0) expectCold(await result, warm);
    else {
      expect(await result).toContain("The check ran out of time");
      expect(e2b.create).not.toHaveBeenCalled();
    }
    expect(Date.now() - start).toBeLessThanOrEqual(elapsed + Math.min(60_000, 240_000 - elapsed));
    expect(timeouts).toHaveLength(elapsed === 0 ? 5 : 4);
    expect(timeouts.at(-1)).toBe(elapsed === 0 ? 10_000 : 2_500);
    expect(commandsOf(warm)).toEqual([]);
  });

  it("stops waiting for an install at the step deadline", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    e2b.list.mockReturnValue({
      nextItems: async () => {
        vi.setSystemTime(start + 200_000);
        return [{ sandboxId: "sbx_warm_0", metadata: { userId: "user_1", projectId: "proj_1" }, endAt: new Date(start + 3_600_000) }];
      },
    });
    const warm = warmSandbox(undefined, [DEV_SERVER, installing("npm install")]);
    fakeSandbox();

    const result = warmCheck();
    await vi.runAllTimersAsync();

    // Too little left for a cold build after the wait, so none starts.
    expect(await result).toMatch(/^Error: The build check could not finish \(The check ran out of time\)/);
    expect(warm.commands.list.mock.calls.length).toBeGreaterThan(1);
    expect(Date.now()).toBeLessThanOrEqual(start + 240_000);
    expect(commandsOf(warm).some((run) => run.startsWith("mkdir"))).toBe(false);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("uses a new sandbox when an install starts between discovery and the copy", async () => {
    listed({});
    const warm = warmSandbox();
    warm.commands.list
      .mockResolvedValueOnce([DEV_SERVER])
      .mockResolvedValueOnce([DEV_SERVER, installing("npm install --prefer-offline --no-audit --no-fund")]);
    fakeSandbox();

    expectCold(await warmCheck(), warm);
    expect(commandsOf(warm).some((run) => run.startsWith("npm install"))).toBe(false);
    expect(commandsOf(warm).at(-1)).toMatch(/^rm -rf \/home\/user\/check-build-/);
  });

  it("uses a new sandbox when package.json or node_modules changed during the copy", async () => {
    listed({});
    let reads = 0;
    const warm = warmSandbox((command) =>
      command.startsWith("stat ")
        ? { exitCode: 0, stdout: `node_modules 2026-11-03 10:00:0${reads++}.000000000 +0000\n` }
        : undefined,
    );
    fakeSandbox();

    expectCold(await warmCheck(), warm);
    expect(commandsOf(warm).some((run) => run.startsWith("npm install"))).toBe(false);
  });

  it("uses a new sandbox when the preview has a .env, without copying", async () => {
    listed({});
    const warm = warmSandbox((command) =>
      command.startsWith("stat ") ? { exitCode: 0, stdout: ".env 2026-11-03 10:00:00.000000000 +0000\n" } : undefined,
    );
    fakeSandbox();

    expectCold(await warmCheck(), warm);
    expect(commandsOf(warm).some((run) => run.startsWith("mkdir"))).toBe(false);
  });

  it("uses a new sandbox when connecting fails", async () => {
    listed({});
    e2b.connect.mockRejectedValue(new Error("502 Bad Gateway"));
    fakeSandbox();

    expectCold(await warmCheck());
  });

  it.each([
    ["the preview has no node_modules to copy", { exitCode: 1, stderr: "cp: cannot stat '/home/user/app/node_modules'" }],
    ["the copy times out", new TimeoutError("Command timed out")],
  ])("uses a new sandbox when %s", async (_case, answer) => {
    listed({});
    const warm = warmSandbox((command) => (command.startsWith("mkdir") ? answer : undefined));
    fakeSandbox();

    expectCold(await warmCheck(), warm);
    expect(commandsOf(warm).at(-1)).toMatch(/^rm -rf \/home\/user\/check-build-/);
  });

  it("uses a new sandbox when the preview goes away mid-check, and cleans up without killing it", async () => {
    listed({});
    const warm = warmSandbox((command) => (command.startsWith("npm install") ? new Error("sandbox not found") : undefined));
    fakeSandbox();

    expectCold(await warmCheck(), warm);
  });

  const slowInstall = (command: string) =>
    command.startsWith("npm install") ? new TimeoutError("Command timed out") : undefined;

  it("builds in a new sandbox when the warm build times out and the step budget allows it", async () => {
    listed({});
    const warm = warmSandbox(slowInstall);
    fakeSandbox();

    expectCold(await warmCheck(), warm);
  });

  it("reports the timeout as unfinished when too little of the step budget is left for a new sandbox", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    const warm = warmSandbox((command) => {
      if (!command.startsWith("npm install")) return undefined;
      now += 185_000;
      return new TimeoutError("Command timed out");
    });

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(The check ran out of time\)/);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
    expect(unfinishedLogs()).toEqual([
      {
        path: "warm-then-before-cold",
        elapsedMs: 185_000,
        budgetLeftMs: 55_000,
        error: "OutOfTime",
        reason: "The check ran out of time",
      },
    ]);
  });

  it("skips the warm preview on the retry after a warm timeout, until the entry expires", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    const warm = warmSandbox(slowInstall);
    fakeSandbox();
    expectCold(await warmCheck(), warm);

    e2b.create.mockClear();
    e2b.connect.mockClear();
    now += 9 * 60_000;
    fakeSandbox();
    expectCold(await warmCheck(), warm);
    expect(e2b.connect).not.toHaveBeenCalled();

    e2b.create.mockClear();
    now += 2 * 60_000;
    fakeSandbox();
    expectCold(await warmCheck(), warm);
    expect(e2b.connect).toHaveBeenCalledTimes(1);
  });

  it("reports one unfinished check when the new sandbox also times out, without another build", async () => {
    listed({});
    warmSandbox(slowInstall);
    const cold = fakeSandbox(new TimeoutError("Command timed out"));

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(Command timed out\)/);
    expect(e2b.create).toHaveBeenCalledTimes(1);
    expect(cold.kill).toHaveBeenCalledTimes(1);
    expect(unfinishedLogs().map((log) => log.path)).toEqual(["warm-then-cold"]);
  });

  it("kills the timed-out build's own processes before removing its directory, never the dev server", async () => {
    listed({});
    const warm = warmSandbox((command) =>
      command.startsWith("npm install") ? new TimeoutError("Command timed out") : undefined,
    );

    fakeSandbox();
    await warmCheck();

    const runs = commandsOf(warm);
    const killAt = runs.findIndex((run) => run.includes("kill -9"));
    const rmAt = runs.findIndex((run) => run.startsWith("rm -rf "));
    const dir = runs[rmAt].slice("rm -rf ".length);
    expect(killAt).toBeGreaterThan(-1);
    expect(killAt).toBeLessThan(rmAt);
    expect(runs[killAt]).toContain(`${dir}|${dir}/*`);
    expect(warm.commands.run.mock.calls[killAt][1]).toMatchObject({ timeoutMs: 10_000, requestTimeoutMs: 10_000 });
    expect(warm.kill).not.toHaveBeenCalled();
  });

  it("still tries a new sandbox and cleans up when killing the build's processes fails", async () => {
    listed({});
    fakeSandbox();
    const warm = warmSandbox((command) => {
      if (command.startsWith("npm install")) return new TimeoutError("Command timed out");
      return command.includes("kill -9") ? new Error("sandbox gone") : undefined;
    });

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(commandsOf(warm).some((run) => run.startsWith("rm -rf "))).toBe(true);
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("kills nothing when the warm build finishes or fails", async () => {
    listed({});
    const warm = warmSandbox((command) => (command.startsWith("npx") ? { exitCode: 1, stderr: "error" } : undefined));

    await warmCheck();

    expect(commandsOf(warm).some((run) => run.includes("kill -9"))).toBe(false);
  });

  it("does not start a new sandbox when a failed warm attempt left too little of the step budget", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    warmSandbox((command) => {
      if (!command.startsWith("npm install")) return undefined;
      now += 200_000;
      return new Error("sandbox not found");
    });

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(The check ran out of time\)/);
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("stops with an unfinished check when slow discovery spends the step budget", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    e2b.list.mockReturnValue({
      nextItems: async () => {
        now += 250_000;
        return [{ sandboxId: "sbx_warm_0", metadata: { userId: "user_1", projectId: "proj_1" }, endAt: new Date(now + 3_600_000) }];
      },
    });
    fakeSandbox();

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(The check ran out of time\)/);
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("never starts the install once a slow copy has spent the step budget", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    const warm = warmSandbox((command) => {
      if (command.startsWith("mkdir")) now += 245_000;
      return undefined;
    });

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(The check ran out of time\)/);
    expect(commandsOf(warm).some((run) => run.startsWith("npm install"))).toBe(false);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("gives the warm build 180 s, so a 130 s install and build still finishes there", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    const warm = warmSandbox((command) => {
      if (command.startsWith("npm install")) now += 130_000;
      return undefined;
    });

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(warm.commands.run.mock.calls.find((call) => call[0].startsWith("npm install"))?.[1]).toMatchObject({
      timeoutMs: 180_000,
    });
    expect(e2b.create).not.toHaveBeenCalled();
  });

  it("bounds each warm command by the time left in the step budget", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    listed({});
    const warm = warmSandbox((command) => {
      if (command.startsWith("mkdir")) now += 150_000;
      return undefined;
    });

    await warmCheck();

    const install = warm.commands.run.mock.calls.find((call) => call[0].startsWith("npm install"));
    expect(install?.[1]).toMatchObject({ timeoutMs: 90_000 });
  });
});

describe("checkBuild tool (#465)", () => {
  /** Convex rows for `files`, with their folders. */
  const rowsOf = (files: Array<{ path: string; content: string }>) => {
    const rows: Array<Record<string, unknown>> = [];
    const folders = new Map<string, string>();
    for (const file of files) {
      const parts = file.path.split("/");
      let parentId: string | undefined;
      for (const [i, name] of parts.slice(0, -1).entries()) {
        const path = parts.slice(0, i + 1).join("/");
        if (!folders.has(path)) {
          folders.set(path, `folder_${path}`);
          rows.push({ _id: `folder_${path}`, type: "folder", name, parentId });
        }
        parentId = folders.get(path);
      }
      rows.push({ _id: `file_${file.path}`, type: "file", name: parts.at(-1), parentId, content: file.content });
    }
    return rows;
  };

  const runTool = async (envVars: unknown, arrange?: () => void) => {
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getEnvVarsForSandbox" ? envVars : rowsOf(starter()),
    );
    arrange?.();
    const tool = createCheckBuildTool({ projectId: "proj_1" as never, internalKey: "internal", ownerId: "user_1" });
    const step = { run: vi.fn(async (_name: string, fn: () => Promise<string>) => fn()) };
    return tool.handler({}, { step } as unknown as Parameters<typeof tool.handler>[1]);
  };

  it("skips the warm preview and redacts the output when the project has secrets", async () => {
    mocks.resolveEnv.mockResolvedValue({
      publicEntries: [],
      secretEntries: [{ key: "DATABASE_URL", value: SECRET }],
      failedKeys: [],
    });
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stdout: `vite.config.ts: DATABASE_URL=${SECRET}` });

    const result = await runTool([{ _id: "env_1", key: "DATABASE_URL", visibility: "secret" }]);

    expect(e2b.list).not.toHaveBeenCalled();
    expect(e2b.create).toHaveBeenCalledTimes(1);
    expect(result).toContain("DATABASE_URL=[redacted]");
    expect(result).not.toContain(SECRET);
  });

  it.each([
    ["reading the variables fails", () => mocks.query.mockImplementation(async (ref) => {
      if (getFunctionName(ref) === "system:getEnvVarsForSandbox") throw new Error("Convex unavailable");
      return rowsOf(starter());
    })],
    ["the secrets cannot be opened", () => mocks.resolveEnv.mockRejectedValue(new Error("CODENAYA_LOCAL_KEK is not set"))],
  ])("still checks, cold, when %s", async (_case, arrange) => {
    fakeSandbox();

    const result = await runTool([{ _id: "env_1", key: "DATABASE_URL", visibility: "secret" }], arrange);

    expect(result?.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.list).not.toHaveBeenCalled();
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the secrets cannot be opened", () => mocks.resolveEnv.mockRejectedValue(new Error("CODENAYA_LOCAL_KEK is not set"))],
    ["reading the variables fails", () => mocks.query.mockImplementation(async (ref) => {
      if (getFunctionName(ref) === "system:getEnvVarsForSandbox") throw new Error("Convex unavailable");
      return rowsOf(starter());
    })],
  ])("hides a failing build's output when %s", async (_case, arrange) => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stdout: `vite.config.ts: DATABASE_URL=${SECRET}` });

    const result = await runTool([{ _id: "env_1", key: "DATABASE_URL", visibility: "secret" }], arrange);

    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain(REDACTION_UNAVAILABLE_NOTICE);
    expect(result).not.toContain("DATABASE_URL");
  });

  it("keeps the static-check result when the variables come back missing", async () => {
    // As in tests whose Convex mock does not know the query (#456).
    const result = await runTool(undefined, () => vi.stubEnv("E2B_API_KEY", ""));

    expect(result?.split("\n")[0]).toBe(STATIC_CHECKS_PASSED);
  });

  it("never sends a secret file's content to the sandbox", async () => {
    const sandbox = fakeSandbox();

    await runTool(undefined, () => mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getEnvVarsForSandbox"
        ? null
        : rowsOf([...starter(), { path: ".env.local", content: "API_KEY=CANARY_VALUE_123" }])));

    const written = JSON.stringify(sandbox.files.write.mock.calls);
    expect(written).toContain("package.json");
    expect(written).not.toContain(".env.local");
    expect(written).not.toContain("CANARY_VALUE_123");
  });

  it("looks for the owner's warm preview when the project has no variables", async () => {
    e2b.list.mockReturnValue({ nextItems: async () => [] });
    fakeSandbox();

    const result = await runTool([]);

    expect(result?.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.list).toHaveBeenCalledWith(
      expect.objectContaining({ query: { metadata: { userId: "user_1", projectId: "proj_1" }, state: ["running"] } }),
    );
    expect(mocks.resolveEnv).not.toHaveBeenCalled();
  });
});
