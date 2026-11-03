import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { CommandExitError, type CommandResult, TimeoutError } from "e2b";
import { getFunctionName } from "convex/server";

import { VITE_REACT_STARTER } from "../vite-starter";
import {
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_PASSED,
} from "../../agent-steps";
import { checkProjectBuild, createCheckBuildTool, trimBuildOutput } from "./check-build";

const starter = () => VITE_REACT_STARTER.map((file) => ({ ...file }));
const check = (files = starter(), apiKey: string | null = "e2b_key") =>
  checkProjectBuild({
    files,
    paths: new Set(files.map((file) => file.path)),
    apiKey: apiKey ?? undefined,
  });

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

type Proc = { cmd: string; args: string[] };

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
      list: vi.fn<() => Promise<Proc[]>>(async () => processes),
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

  it("falls back to the static checks without an E2B key", async () => {
    const result = await check(starter(), null);
    expect(result.split("\n")[0]).toBe(STATIC_CHECKS_PASSED);
    expect(result).toContain("No build sandbox is configured");
    expect(e2b.create).not.toHaveBeenCalled();
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
      "npm install --prefer-offline --no-audit --no-fund --loglevel=error",
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
});

const SECRET = "sk_live_SYNTHETIC_0123456789";

describe("checkProjectBuild redaction (#465)", () => {
  it("redacts the project's secrets from build errors", async () => {
    fakeSandbox({ exitCode: 0 }, { exitCode: 1, stderr: `Error: connect ECONNREFUSED postgres://app:${SECRET}@db` });
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      apiKey: "e2b_key",
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
      apiKey: "e2b_key",
      secrets: [key],
    });
    expect(result).toMatch(/^Error: Build failed/);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("SYNTHETICKEYMATERIAL");
    expect(result).not.toContain("BEGIN PRIVATE KEY");
  });

  it("redacts the project's secrets from an unfinished check", async () => {
    fakeSandbox(new TimeoutError(`Command timed out: ${SECRET}`));
    const files = starter();
    const result = await checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      apiKey: "e2b_key",
      secrets: [SECRET],
    });
    expect(result).toMatch(/^Error: The build check could not finish/);
    expect(result).not.toContain(SECRET);
  });
});

const DEV_SERVER: Proc = { cmd: "/bin/bash", args: ["-l", "-c", "npm run dev -- --host"] };
const installing = (command: string): Proc => ({ cmd: "/bin/bash", args: ["-l", "-c", command] });

describe("checkProjectBuild in the warm preview sandbox (#465)", () => {
  const warmCheck = () => {
    const files = starter();
    return checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      apiKey: "e2b_key",
      metadata: { projectId: "proj_1", purpose: "check-build" },
      preview: { projectId: "proj_1", ownerId: "user_1" },
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
  ])("uses a new sandbox while the preview runs `%s`, and leaves the preview alone", async (command) => {
    listed({});
    const warm = warmSandbox(undefined, [DEV_SERVER, installing(command)]);
    fakeSandbox();

    expectCold(await warmCheck(), warm);
    expect(commandsOf(warm).filter((run) => !run.startsWith("rm -rf"))).toEqual([]);
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

  it("reports a timeout in the warm build as unfinished, without a second build", async () => {
    listed({});
    const warm = warmSandbox((command) =>
      command.startsWith("npm install") ? new TimeoutError("Command timed out") : undefined,
    );

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(Command timed out\)/);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
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

  const runTool = async (envVars: unknown[]) => {
    vi.stubEnv("E2B_API_KEY", "e2b_key");
    mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getEnvVarsForSandbox" ? envVars : rowsOf(starter()),
    );
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
