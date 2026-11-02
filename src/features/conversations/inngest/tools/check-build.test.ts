import { beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), connect: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: e2b.create, list: e2b.list, connect: e2b.connect },
}));

import { CommandExitError, type CommandResult, TimeoutError } from "e2b";

import { VITE_REACT_STARTER } from "../vite-starter";
import {
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_PASSED,
} from "../../agent-steps";
import { checkProjectBuild, trimBuildOutput } from "./check-build";

const starter = () => VITE_REACT_STARTER.map((file) => ({ ...file }));
const check = (files = starter(), apiKey: string | null = "e2b_key") =>
  checkProjectBuild({
    files,
    paths: new Set(files.map((file) => file.path)),
    apiKey: apiKey ?? undefined,
  });

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

/** A sandbox whose commands answer in order: a result, or an error to throw. */
const sandboxWith = (answers: Answer[], processes: Array<{ cmd: string; args: string[] }> = []) => ({
    files: { makeDir: vi.fn(async () => true), write: vi.fn(async () => ({})) },
    commands: {
      run: vi.fn<(command: string, opts?: object) => Promise<CommandResult>>(async () => {
        const answer = answers.shift() ?? { exitCode: 0 };
        if (answer instanceof Error) throw answer;
        const result = { stdout: "", stderr: "", ...answer };
        if (result.exitCode !== 0) throw new CommandExitError(result);
        return result;
      }),
      list: vi.fn(async () => processes),
    },
    kill: vi.fn(async () => {}),
});

/** The throwaway sandbox a cold check creates. */
const fakeSandbox = (...answers: Answer[]) => {
  const sandbox = sandboxWith(answers);
  e2b.create.mockResolvedValue(sandbox);
  return sandbox;
};

beforeEach(() => {
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

describe("checkProjectBuild in the warm preview sandbox (#465)", () => {
  const preview = { projectId: "proj_1", ownerId: "user_1" };
  const warmCheck = () => {
    const files = starter();
    return checkProjectBuild({
      files,
      paths: new Set(files.map((file) => file.path)),
      apiKey: "e2b_key",
      metadata: { projectId: "proj_1", purpose: "check-build" },
      preview,
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
  const warmSandbox = (...answers: Answer[]) => {
    const sandbox = sandboxWith(answers, [{ cmd: "/bin/bash", args: ["-l", "-c", "npm run dev -- --host"] }]);
    e2b.connect.mockResolvedValue(sandbox);
    return sandbox;
  };
  const commandsOf = (sandbox: ReturnType<typeof sandboxWith>) =>
    sandbox.commands.run.mock.calls.map((call) => (call as unknown[])[0] as string);

  it("builds in its own directory of the owner's running preview, without killing it or creating a sandbox", async () => {
    listed({});
    const warm = warmSandbox();
    const cold = fakeSandbox();

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userId: "user_1", projectId: "proj_1" }, state: ["running"] },
      }),
    );
    // No longer than the time the sandbox already has left, so its timeout is unchanged.
    expect(e2b.connect).toHaveBeenCalledWith("sbx_warm_0", { apiKey: "e2b_key", timeoutMs: 180_000 });
    const [copy, install, build, cleanup] = commandsOf(warm);
    const dir = copy.match(/mkdir -p (\/home\/user\/check-build-\w+) && cp -a \/home\/user\/app\/node_modules /)?.[1];
    expect(dir).toBeDefined();
    expect(install).toMatch(/^npm install/);
    expect(build).toBe("npx tsc --noEmit -p tsconfig.app.json && npx vite build");
    expect(warm.commands.run.mock.calls[1]).toEqual([install, expect.objectContaining({ cwd: dir })]);
    expect(cleanup).toBe(`rm -rf ${dir}`);
    expect(warm.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([{ path: `${dir}/src/App.tsx`, data: expect.any(String) }]),
    );
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
    expect(cold.kill).not.toHaveBeenCalled();
  });

  it("reports build errors from the warm sandbox with its paths made relative", async () => {
    listed({});
    const warm = warmSandbox();
    let dir = "";
    warm.commands.run.mockImplementation(async (command: string) => {
      dir ||= command.split(" ")[2];
      if (!command.startsWith("npx tsc")) return { exitCode: 0, stdout: "", stderr: "" };
      throw new CommandExitError({
        exitCode: 2,
        stdout: `${dir}/src/App.tsx(3,7): error TS2322: Bad type.\n`,
        stderr: "",
      });
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
    ["the preview is about to expire", () => listed({ minutesLeft: 2 })],
  ])("uses a new sandbox when %s, without connecting", async (_case, arrange) => {
    arrange();
    const cold = fakeSandbox();

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.connect).not.toHaveBeenCalled();
    expect(cold.kill).toHaveBeenCalledTimes(1);
  });

  it("uses a new sandbox while the preview is installing, and leaves the preview alone", async () => {
    listed({});
    const warm = sandboxWith([], [{ cmd: "/bin/bash", args: ["-l", "-c", "npm install --prefer-offline"] }]);
    e2b.connect.mockResolvedValue(warm);
    fakeSandbox();

    const result = await warmCheck();

    expect(result.split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(warm.commands.run).not.toHaveBeenCalled();
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("uses a new sandbox when listing or connecting fails", async () => {
    listed({});
    e2b.connect.mockRejectedValue(new Error("502 Bad Gateway"));
    fakeSandbox();

    expect((await warmCheck()).split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("uses a new sandbox when the preview has no node_modules to copy", async () => {
    listed({});
    const warm = warmSandbox({ exitCode: 1, stderr: "cp: cannot stat '/home/user/app/node_modules'" });
    fakeSandbox();

    expect((await warmCheck()).split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(commandsOf(warm).at(-1)).toMatch(/^rm -rf \/home\/user\/check-build-/);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("uses a new sandbox when the preview goes away mid-check, and cleans up without killing it", async () => {
    listed({});
    const warm = warmSandbox({ exitCode: 0 }, new Error("sandbox not found"));
    fakeSandbox();

    expect((await warmCheck()).split("\n")[0]).toBe(BUILD_VERIFIED);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout in the warm sandbox as unfinished, without a second build", async () => {
    listed({});
    const warm = warmSandbox({ exitCode: 0 }, new TimeoutError("Command timed out"));

    const result = await warmCheck();

    expect(result).toMatch(/^Error: The build check could not finish \(Command timed out\)/);
    expect(warm.kill).not.toHaveBeenCalled();
    expect(e2b.create).not.toHaveBeenCalled();
  });
});
