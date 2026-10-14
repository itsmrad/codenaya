import { beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: e2b.create },
}));

import { CommandExitError, TimeoutError } from "e2b";

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

/** A fake sandbox whose commands answer in order: a result, or an error to throw. */
const fakeSandbox = (...answers: Array<{ exitCode: number; stdout?: string; stderr?: string } | Error>) => {
  const sandbox = {
    files: { makeDir: vi.fn(async () => true), write: vi.fn(async () => ({})) },
    commands: {
      run: vi.fn(async () => {
        const answer = answers.shift() ?? { exitCode: 0 };
        if (answer instanceof Error) throw answer;
        const result = { stdout: "", stderr: "", ...answer };
        if (result.exitCode !== 0) throw new CommandExitError(result);
        return result;
      }),
    },
    kill: vi.fn(async () => {}),
  };
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
      "npm install --no-audit --no-fund --loglevel=error",
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

  it("reports a timeout as an unfinished check, not a code error, and still kills the sandbox", async () => {
    const sandbox = fakeSandbox(new TimeoutError("Command timed out"));
    const result = await check();
    expect(result).toMatch(/^Error: The build check could not finish \(Command timed out\)/);
    expect(result).toContain("not an error in the project's code");
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });
});
