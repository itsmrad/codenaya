import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOTHING_TO_PREVIEW } from "./boot-plan";
import {
  appErrorKey,
  autoFixTarget,
  bannerError,
  buildFixPrompt,
  createBuildErrorDetector,
  codeBlock,
  createAutoFixer,
  detectBuildError,
  isAppStartFailure,
  isHmrSuccess,
  logTail,
  mergeAppError,
  overlayError,
  readInstallFailure,
  trackFixAttempts,
} from "./app-error";
import {
  VITE8_DEV_SYNTAX_ERROR,
  VITE8_DEV_UNRESOLVED_IMPORT,
} from "../../conversations/inngest/tools/vite-build-output.fixture";
import {
  NEXT16_DEV_COMPILED,
  NEXT16_DEV_MODULE_NOT_FOUND,
  NEXT16_DEV_RENDER_ERROR,
  NEXT16_DEV_SYNTAX_ERROR,
} from "./next-dev-output.fixture";

describe("detectBuildError", () => {
  it("reads Vite's unresolved import with its file and line", () => {
    const chunk =
      '3:04:05 PM \x1b[31m[vite]\x1b[39m (client) Internal server error: Failed to resolve import "./Missing" from "src/App.jsx". Does the file exist?\n' +
      "  Plugin: vite:import-analysis\n" +
      "  File: /home/user/app/src/App.jsx:1:20\n";
    expect(detectBuildError(chunk)).toEqual({
      kind: "build",
      message: 'Failed to resolve import "./Missing" from "src/App.jsx". Does the file exist?',
      file: "src/App.jsx",
      line: 1,
    });
  });

  it("falls back to the importing file when there is no File line", () => {
    const chunk =
      '[vite] Pre-transform error: Failed to resolve import "./Missing" from "src/App.jsx". Does the file exist?\n';
    expect(detectBuildError(chunk)).toMatchObject({ file: "src/App.jsx", line: undefined });
  });

  it("reads a postcss plugin error (#328)", () => {
    const chunk =
      "[plugin:vite:css] [postcss] /home/user/app/src/index.css:5:1: The `border-border` class does not exist.\n";
    expect(detectBuildError(chunk)).toEqual({
      kind: "build",
      message: "[plugin:vite:css] [postcss] src/index.css:5:1: The `border-border` class does not exist.",
      file: "src/index.css",
      line: 5,
    });
  });

  it("joins esbuild's 'Transform failed' header with the error under it", () => {
    const chunk =
      "X [ERROR] Transform failed with 1 error:\n/home/user/app/src/App.tsx:5:2: ERROR: Expected \";\" but found \"x\"\n";
    expect(detectBuildError(chunk)).toMatchObject({
      message: 'X [ERROR] Transform failed with 1 error: src/App.tsx:5:2: ERROR: Expected ";" but found "x"',
      file: "src/App.tsx",
      line: 5,
    });
  });

  it("reads Vite 8's Oxc parse error from its code frame, past the blank line after the header", () => {
    expect(detectBuildError(VITE8_DEV_SYNTAX_ERROR)).toEqual({
      kind: "build",
      message: "Transform failed with 1 error: [PARSE_ERROR] Unexpected token",
      file: "src/App.tsx",
      line: 2,
    });
  });

  it("reads Vite 8's unresolved import, which keeps the Vite 6 shape", () => {
    expect(detectBuildError(VITE8_DEV_UNRESOLVED_IMPORT)).toEqual({
      kind: "build",
      message: 'Failed to resolve import "./components/Missing" from "src/App.tsx". Does the file exist?',
      file: "src/App.tsx",
      line: 1,
    });
  });

  it("reads a tsc error", () => {
    expect(
      detectBuildError("src/App.tsx(3,20): error TS2307: Cannot find module './Missing'.\n"),
    ).toMatchObject({ file: "src/App.tsx", line: 3 });
  });

  it.each([
    "Module not found: Can't resolve 'missing-package'",
    "Type error: Type 'number' is not assignable to type 'string'.",
  ])("reads a Next.js location header followed by %s", (message) => {
    expect(detectBuildError(`\x1b[31m⨯\x1b[0m ./src/app/page.tsx:12:3\n${message}\n`)).toEqual({
      kind: "build", message, file: "src/app/page.tsx", line: 12,
    });
  });

  it.each(["src/app/page.tsx", "./src/app/page.tsx"])("reads a Next.js runtime stack at %s", (file) => {
    expect(detectBuildError(`⨯ Error: Render failed\n    at Foo (${file}:12:3)\n`)).toEqual({
      kind: "build", message: "Error: Render failed", file: "src/app/page.tsx", line: 12,
    });
  });

  it.each([
    ["⨯ ReferenceError: window is not defined", "ReferenceError: window is not defined"],
    ["Error: document is not defined", "Error: document is not defined"],
    ["ReferenceError: localStorage is not defined", "ReferenceError: localStorage is not defined"],
    ["Module not found: Can't resolve './missing'", "Module not found: Can't resolve './missing'"],
    ["Type error: Invalid page props", "Type error: Invalid page props"],
    ["Unhandled Runtime Error\nError: Render failed", "Unhandled Runtime Error Error: Render failed"],
  ])("reads the Next.js error %s", (output, message) => {
    expect(detectBuildError(output)).toEqual({ kind: "build", message });
  });

  it.each([
    "⚠ Module not found: Can't resolve 'optional-package'",
    "⚠ Error: optional integration is not defined",
    "✓ Compiled /error in 300ms",
    "○ Compiling /error ...",
  ])("ignores Next.js status and warning output: %s", (output) => {
    expect(detectBuildError(output)).toBeNull();
  });

  it("waits for a Next.js location's message across chunks", () => {
    const detector = createBuildErrorDetector();
    expect(detector.push("⨯ ./src/app/page.tsx:12:3\n")).toBeNull();
    expect(detector.push("Module not found: Can't resolve 'missing-package'\n")).toEqual({
      kind: "build", message: "Module not found: Can't resolve 'missing-package'",
      file: "src/app/page.tsx", line: 12,
    });
  });

  it("skips blank lines between a Next.js location and its error", () => {
    expect(detectBuildError("⨯ ./src/app/page.tsx:12:3\n\n  \nModule not found: Can't resolve 'missing-package'\n")).toEqual({
      kind: "build", message: "Module not found: Can't resolve 'missing-package'",
      file: "src/app/page.tsx", line: 12,
    });
  });

  it.each([
    [NEXT16_DEV_MODULE_NOT_FOUND, "Error: Module not found: Can't resolve '@/components/Hero'", 3],
    [NEXT16_DEV_SYNTAX_ERROR, "Error: Expected ',', got ';'", 6],
    [NEXT16_DEV_RENDER_ERROR, "Error: STRIPE_SECRET_KEY is not set", 2],
  ])("reads captured Next 16 (Turbopack) dev output: %#", (output, message, line) => {
    expect(detectBuildError(output)).toEqual({ kind: "build", message, file: "src/app/page.tsx", line });
  });

  it("forgets a Next 16 dev error once Turbopack compiles again", () => {
    const detector = createBuildErrorDetector();
    expect(detector.push(NEXT16_DEV_MODULE_NOT_FOUND)).not.toBeNull();
    expect(detector.push(NEXT16_DEV_COMPILED)).toBeNull();
  });

  describe("npm install failures (#491)", () => {
    const install = "npm install --prefer-offline --no-audit --no-fund";

    it("reads the sandbox route's install line as a build error on package.json", () => {
      const output =
        `$ ${install}\n` +
        "npm error code ERESOLVE\n" +
        "npm error ERESOLVE unable to resolve dependency tree\n" +
        `\nError: ${install} failed with exit code 1\n` +
        "npm error code ERESOLVE\n";
      expect(detectBuildError(output)).toEqual({
        kind: "build",
        message: `${install} failed with exit code 1 (ERESOLVE)`,
        file: "package.json",
      });
    });

    it("reads a reinstall failure without an npm code", () => {
      expect(detectBuildError(`\npackage.json changed.\n$ pnpm install\n\nError: pnpm install failed with exit code 1\n`)).toEqual({
        kind: "build",
        message: "pnpm install failed with exit code 1",
        file: "package.json",
      });
    });

    it("leaves a network failure to the start error", () => {
      expect(
        detectBuildError(
          "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/react failed\n" +
            `Error: ${install} failed with exit code 1\n`,
        ),
      ).toBeNull();
      expect(detectBuildError(`npm error code EAI_AGAIN\nError: ${install} failed with exit code 1\n`)).toBeNull();
      // The registry failing is not the app's dependencies either.
      expect(detectBuildError(`npm error code E503\nError: ${install} failed with exit code 1\n`)).toBeNull();
      expect(detectBuildError(`npm error socket hang up\nError: ${install} failed with exit code 1\n`)).toBeNull();
    });

    it("reads an install failure after the app's own network errors", () => {
      const chunk =
        "Error: socket hang up\n    at connResetException (node:internal/errors:720:14)\n" +
        "[vite] http proxy error: /api\nError: connect ECONNREFUSED 127.0.0.1:3001\n" +
        `npm error code ERESOLVE\nError: ${install} failed with exit code 1\n`;
      expect(detectBuildError(chunk)).toMatchObject({ file: "package.json", message: expect.stringContaining("(ERESOLVE)") });
    });

    it("ignores other lines that mention an exit code", () => {
      expect(detectBuildError("Error: Command failed with exit code 1: vite build\n")).toBeNull();
      expect(detectBuildError("Error: exit status 1\n")).toBeNull();
    });
  });

  it("ignores ordinary output", () => {
    expect(detectBuildError("  VITE v6.0.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n")).toBeNull();
    expect(detectBuildError("[vite] hmr update /src/App.jsx\n")).toBeNull();
  });
});

describe("isHmrSuccess", () => {
  it("matches Next.js successful compilation lines", () => {
    expect(isHmrSuccess("✓ Compiled /route in 1.2s")).toBe(true);
    expect(isHmrSuccess("○ Compiling /route ...\n  \x1b[32m✓\x1b[0m Compiled /route in 1.2s\n")).toBe(true);
    expect(isHmrSuccess("⚠ Compiled with warnings")).toBe(false);
  });

  it("matches Vite 5 and Vite 6 update lines", () => {
    expect(isHmrSuccess("3:04:05 PM [vite] hmr update /src/App.jsx")).toBe(true);
    expect(isHmrSuccess("3:04:05 PM \x1b[36m[vite]\x1b[39m (client) page reload index.html")).toBe(true);
    expect(isHmrSuccess("compiled successfully")).toBe(false);
  });
});

describe("mergeAppError", () => {
  const error = { kind: "build" as const, message: "boom", file: "src/App.jsx" };

  it("keeps the shown error when the same one repeats", () => {
    const shown = { ...error, line: 3 };
    expect(mergeAppError(shown, { ...error })).toBe(shown);
    expect(mergeAppError(shown, { ...error, line: 4 })).toBe(shown);
  });

  it("takes a new error, or the same one once it has a line", () => {
    const next = { ...error, message: "other" };
    expect(mergeAppError({ ...error }, next)).toBe(next);
    const withLine = { ...error, line: 3 };
    expect(mergeAppError({ ...error }, withLine)).toBe(withLine);
    expect(appErrorKey(error)).toBe(appErrorKey(withLine));
  });
});

describe("buildFixPrompt", () => {
  it("includes the error, where it is, the stack and the log tail", () => {
    const output = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const prompt = buildFixPrompt(
      { kind: "runtime", message: "x is not defined", stack: "at App (App.jsx:3)", file: "src/App.jsx", line: 3 },
      output,
    );
    expect(prompt).toContain("runtime error in src/App.jsx:3");
    expect(prompt).toContain("x is not defined");
    expect(prompt).toContain("at App (App.jsx:3)");
    expect(prompt).toContain("line 59");
    expect(prompt).toContain("line 10");
    expect(prompt).not.toContain("line 9\n");
  });

  it("appends the known cause and fix for a recognised error (#334)", () => {
    const prompt = buildFixPrompt(
      { kind: "build", message: "npm install failed with exit code 1 (ERESOLVE)", file: "package.json" },
      "npm error code ERESOLVE\n",
    );
    expect(prompt).toContain("Likely cause (npm-eresolve):");
    expect(prompt).toContain("Known fix:");
  });

  it("leaves out sections it has nothing for", () => {
    expect(buildFixPrompt({ kind: "build", message: "boom" }, "")).toBe(
      "The preview shows a build error. Find the cause and fix it.\n\nError:\n```\nboom\n```",
    );
  });
});

describe("logTail", () => {
  it("strips escape codes and keeps the text after the last carriage return", () => {
    expect(logTail("\x1b[32mok\x1b[39m\nprogress 10%\rdone\n\n", 2)).toBe("ok\ndone");
  });
});

describe("codeBlock", () => {
  it("uses a plain fence for ordinary text", () => {
    expect(codeBlock("boom")).toBe("```\nboom\n```");
  });

  it("outlasts the longest backtick run in the text", () => {
    expect(codeBlock("see ```js\nx\n``` and `y`")).toBe("````\nsee ```js\nx\n``` and `y`\n````");
    expect(codeBlock("``````")).toBe("```````\n``````\n```````");
  });

  it("keeps a fix prompt's error inside its block", () => {
    const prompt = buildFixPrompt({ kind: "build", message: "Unexpected ``` here" }, "");
    expect(prompt).toContain("````\nUnexpected ``` here\n````");
  });
});

describe("bannerError", () => {
  const error = { kind: "build" as const, message: "boom", file: "src/App.tsx" };
  const shown = { dismissedId: null, previewReady: true, firstBuildRunning: false };

  it("shows an error over a running preview", () => {
    expect(bannerError(error, shown)).toBe(error);
  });

  it("hides it while a new project's first build is still running (#337)", () => {
    expect(bannerError(error, { ...shown, firstBuildRunning: true })).toBeNull();
  });

  it("hides it once dismissed, without a preview, or with no error", () => {
    expect(bannerError(error, { ...shown, dismissedId: appErrorKey(error) })).toBeNull();
    expect(bannerError(error, { ...shown, previewReady: false })).toBeNull();
    expect(bannerError(null, shown)).toBeNull();
  });
});

describe("isAppStartFailure", () => {
  it("is a failed start the app's code can fix", () => {
    expect(isAppStartFailure("transient", "npm install failed with exit code 1")).toBe(true);
  });

  it("is not a sandbox setup failure, or a project with nothing to preview", () => {
    expect(isAppStartFailure("config", "E2B_API_KEY is not set")).toBe(false);
    expect(isAppStartFailure("rate_limit", "Sandbox limit reached")).toBe(false);
    expect(isAppStartFailure("transient", NOTHING_TO_PREVIEW)).toBe(false);
    expect(isAppStartFailure(null, null)).toBe(false);
  });
});

describe("autoFixTarget (#491)", () => {
  const idle = { runActive: false, chatBusy: false, sent: [] as string[], max: 2 };

  it("fixes the shown error once the run is over and the chat is free", () => {
    expect(autoFixTarget("a", idle)).toBe("a");
    expect(autoFixTarget("a", { ...idle, runActive: true })).toBeNull();
    expect(autoFixTarget("a", { ...idle, chatBusy: true })).toBeNull();
    expect(autoFixTarget(null, idle)).toBeNull();
  });

  it("fixes each error once, and at most max per session", () => {
    expect(autoFixTarget("a", { ...idle, sent: ["a"] })).toBeNull();
    expect(autoFixTarget("b", { ...idle, sent: ["a"] })).toBe("b");
    expect(autoFixTarget("c", { ...idle, sent: ["a", "b"] })).toBeNull();
  });
});

describe("trackFixAttempts", () => {
  const start = { errorId: null, count: 0 };

  it("keeps the count while the same error is cleared between fix runs", () => {
    const afterTwo = { errorId: "a", count: 2 };
    expect(trackFixAttempts(afterTwo, null)).toBe(afterTwo);
    expect(trackFixAttempts(afterTwo, "a")).toBe(afterTwo);
  });

  it("starts again when a different error becomes active", () => {
    expect(trackFixAttempts({ errorId: "a", count: 2 }, "b")).toEqual({ errorId: "b", count: 0 });
    expect(trackFixAttempts(start, "a")).toEqual({ errorId: "a", count: 0 });
  });

  it("doesn't carry old attempts over when an earlier error comes back after another", () => {
    const onB = trackFixAttempts({ errorId: "a", count: 2 }, "b");
    expect(trackFixAttempts(onB, "a")).toEqual({ errorId: "a", count: 0 });
  });
});

describe("createBuildErrorDetector", () => {
  it("forgets error A after Next.js compiles so the next error B is shown", () => {
    const detector = createBuildErrorDetector();
    expect(detector.push("⨯ Error: A\n")).toEqual({ kind: "build", message: "Error: A" });
    expect(detector.push("✓ Compiled /x in 5ms\n")).toBeNull();
    expect(detector.push("⨯ Error: B\n")).toEqual({ kind: "build", message: "Error: B" });
  });

  const chunk =
    '[vite] Internal server error: Failed to resolve import "./Missing" from "src/App.jsx". Does the file exist?\n' +
    "  Plugin: vite:import-analysis\n" +
    "  File: /home/user/app/src/App.jsx:1:20\n";

  it("takes the file from the error, not from older output in the tail", () => {
    const detector = createBuildErrorDetector();
    detector.push("[postcss] /home/user/app/src/old.css:9:1: a deprecated rule (warning)\n");
    expect(
      detector.push('[vite] Pre-transform error: Failed to resolve import "./Missing" from "src/App.jsx".\n'),
    ).toMatchObject({ file: "src/App.jsx", line: undefined });
  });

  it("reads an error the stream split across chunks", () => {
    const css =
      "[plugin:vite:css] [postcss] /home/user/app/src/index.css:5:1: The `border-border` class does not exist.\n";
    const [head, rest] = [css.slice(0, 10), css.slice(10)]; // "[plugin:vi" | "te:css] ..."
    expect(detectBuildError(head)).toBeNull();
    expect(detectBuildError(rest)).toBeNull();

    const detector = createBuildErrorDetector();
    expect(detector.push(head)).toBeNull();
    expect(detector.push(rest)).toMatchObject({ file: "src/index.css", line: 5 });
  });

  it("forgets earlier output once reset, and keeps only a bounded tail", () => {
    const detector = createBuildErrorDetector();
    detector.push(chunk);
    detector.reset();
    expect(detector.push("  VITE ready\n")).toBeNull();

    detector.push(chunk);
    expect(detector.push("x".repeat(10_000))).toBeNull();
  });
});

describe("createAutoFixer (#491)", () => {
  const files = ["run's files"];
  const fix = vi.fn();
  /** The last `onFixingChange` value. */
  let fixing = false;
  let fixer: ReturnType<typeof createAutoFixer>;
  const state = { errorId: null as string | null, runActive: false, chatBusy: false, files: files as unknown };
  const update = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    fixer.update({ ...state, fix });
  };
  /** A run that starts, then ends with `errorId` shown. */
  const runEnds = (errorId: string | null = "a") => {
    update({ runActive: true });
    update({ runActive: false, errorId });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fix.mockReset();
    fixing = false;
    Object.assign(state, { errorId: null, runActive: false, chatBusy: false, files });
    fixer = createAutoFixer({
      delayMs: 3000,
      windowMs: 120_000,
      max: 2,
      onFixingChange: (next) => (fixing = next),
    });
    update({});
  });
  afterEach(() => {
    fixer.dispose();
    vi.useRealTimers();
  });

  it("fixes the error a run left once it has stayed shown for the delay", () => {
    runEnds("a");
    vi.advanceTimersByTime(2999);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("does nothing on a page load with an error already shown", () => {
    update({ errorId: "a" });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("drops the pending fix when the error clears or changes before the delay", () => {
    runEnds("a");
    vi.advanceTimersByTime(2000);
    update({ errorId: null });
    vi.advanceTimersByTime(5000);
    expect(fix).not.toHaveBeenCalled();

    update({ errorId: "b" });
    vi.advanceTimersByTime(2000);
    update({ errorId: "c" });
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("fixes an error that comes back after the reload that cleared it (#486)", () => {
    // The first build's end reloads the preview, which clears its error; a real
    // one is reported again by the new page and still gets one fix.
    runEnds("a");
    update({ errorId: null });
    vi.advanceTimersByTime(1000);
    update({ errorId: "a" });
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("keeps the first deadline through repeated reload clears (#486)", () => {
    runEnds("a");
    for (let reload = 0; reload < 2; reload++) {
      vi.advanceTimersByTime(1000);
      update({ errorId: null });
      vi.advanceTimersByTime(100);
      update({ errorId: "a" });
    }
    vi.advanceTimersByTime(799);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
    update({ errorId: null });
    update({ errorId: "a" });
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledTimes(1);
  });

  it("never fixes an error healed by the reload", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ errorId: null });
    vi.advanceTimersByTime(120_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("gives a different error after a clear the full delay", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ errorId: null });
    vi.advanceTimersByTime(1000);
    update({ errorId: "b" });
    vi.advanceTimersByTime(2999);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("starts a new delay when the same error returns after its old deadline", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ errorId: null });
    vi.advanceTimersByTime(3000);
    update({ errorId: "a" });
    vi.advanceTimersByTime(2999);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("forgets a cleared error's deadline when a file edit disarms it", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ errorId: null });
    update({ files: ["user edit"] });
    update({ errorId: "a" });
    vi.advanceTimersByTime(1000);
    expect(fix).not.toHaveBeenCalled();

    runEnds("a");
    vi.advanceTimersByTime(2999);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("starts a fresh delay after the chat interrupts a pending fix", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ chatBusy: true });
    vi.advanceTimersByTime(1000);
    update({ chatBusy: false });
    vi.advanceTimersByTime(2999);
    expect(fix).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("disarms on a file edit after the run ended: the user's typo is left alone", () => {
    runEnds(null);
    update({ files: ["user edit"] });
    update({ errorId: "typo" });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("disarms on an edit while a fix is pending", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    update({ files: ["user edit"] });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("counts files the run itself wrote as the run's, not an edit", () => {
    update({ runActive: true });
    update({ runActive: false, errorId: "a", files: ["written by the run"] });
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledWith("a");
  });

  it("disarms once the window after the run is over", () => {
    runEnds(null);
    vi.advanceTimersByTime(120_000);
    update({ errorId: "late" });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("waits while a run is active and while the chat is busy", () => {
    update({ runActive: true, errorId: "a" });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();

    update({ runActive: false, chatBusy: true });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();

    update({ chatBusy: false });
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("cancels a pending fix when the user clicks Fix first", () => {
    runEnds("a");
    vi.advanceTimersByTime(1000);
    // The manual fix is queued: the chat is busy, then its run starts.
    update({ chatBusy: true });
    update({ chatBusy: false, runActive: true });
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });

  it("fixes each error once and at most max per session, across runs", () => {
    runEnds("a");
    vi.advanceTimersByTime(3000);
    runEnds("a"); // the fix run ended and the error is still there
    vi.advanceTimersByTime(3000);
    expect(fix).toHaveBeenCalledTimes(1);

    runEnds("b");
    vi.advanceTimersByTime(3000);
    runEnds("c");
    vi.advanceTimersByTime(3000);
    expect(fix.mock.calls).toEqual([["a"], ["b"]]);
  });

  // #305: the preview shows "Fixing" in place of the broken app meanwhile.
  describe("fixing", () => {
    it("covers the pending fix, its run and the settle after it", () => {
      runEnds("a");
      expect(fixing).toBe(true);
      vi.advanceTimersByTime(3000);
      expect(fix).toHaveBeenCalledWith("a");
      // Queued, then the fix run.
      update({ chatBusy: true });
      update({ chatBusy: false, runActive: true });
      vi.advanceTimersByTime(600_000);
      expect(fixing).toBe(true);

      // The fix worked: the error clears within the settle delay.
      update({ runActive: false });
      update({ errorId: null });
      vi.advanceTimersByTime(2999);
      expect(fixing).toBe(true);
      vi.advanceTimersByTime(1);
      expect(fixing).toBe(false);
    });

    it("stops when the error clears before the fix is sent", () => {
      runEnds("a");
      update({ errorId: null });
      expect(fixing).toBe(false);
      expect(fix).not.toHaveBeenCalled();
    });

    it("stops on the user's edit, so their change is theirs to see", () => {
      runEnds("a");
      update({ files: ["user edit"] });
      expect(fixing).toBe(false);
    });

    it("ends once the attempts are spent, so the error shows with its actions", () => {
      runEnds("a");
      vi.advanceTimersByTime(3000);
      runEnds("a"); // the fix run left the same error
      vi.advanceTimersByTime(3000);
      expect(fixing).toBe(false);
      expect(fix).toHaveBeenCalledTimes(1);
    });

    it("ends when a sent fix starts no run", () => {
      runEnds("a");
      vi.advanceTimersByTime(3000);
      expect(fixing).toBe(true);
      vi.advanceTimersByTime(120_000);
      expect(fixing).toBe(false);
    });

    it("spends nothing on errors that come and go while the run writes", () => {
      update({ runActive: true });
      for (const errorId of ["half-written a", null, "half-written b", null]) {
        update({ errorId, files: [errorId] });
        vi.advanceTimersByTime(10_000);
      }
      expect(fixing).toBe(false);
      expect(fix).not.toHaveBeenCalled();

      // The finished build is clean: nothing to fix, nothing covered.
      update({ runActive: false, errorId: null });
      vi.advanceTimersByTime(10_000);
      expect(fixing).toBe(false);
      expect(fix).not.toHaveBeenCalled();
    });

    it("is never on for a page load with an error already shown", () => {
      update({ errorId: "a" });
      expect(fixing).toBe(false);
    });
  });

  it("sends nothing after dispose", () => {
    runEnds("a");
    fixer.dispose();
    vi.advanceTimersByTime(10_000);
    expect(fix).not.toHaveBeenCalled();
  });
});

describe("readInstallFailure (#497)", () => {
  it("turns a sync's failed reinstall into a package.json build error", () => {
    expect(
      readInstallFailure({ success: true, installFailed: { exitCode: 1, code: "ERESOLVE" } }, "npm install"),
    ).toEqual({
      output: "npm error code ERESOLVE\nError: npm install failed with exit code 1\n",
      error: {
        kind: "build",
        message: "npm install failed with exit code 1 (ERESOLVE)",
        file: "package.json",
      },
    });
  });

  it("builds the message without a code when npm printed none", () => {
    expect(readInstallFailure({ installFailed: { exitCode: 2 } }, "pnpm install")?.error).toEqual({
      kind: "build",
      message: "pnpm install failed with exit code 2",
      file: "package.json",
    });
  });

  it("shows no error for a network failure", () => {
    expect(
      readInstallFailure({ installFailed: { exitCode: 1, code: "ETIMEDOUT" } }, "npm install")?.error,
    ).toBeNull();
  });

  it("is null for a sync that installed nothing, or a malformed body", () => {
    for (const body of [{ success: true, synced: 1 }, { installFailed: { exitCode: "1" } }, null, "x"]) {
      expect(readInstallFailure(body, "npm install")).toBeNull();
    }
  });
});

describe("overlayError (#497)", () => {
  it("reads the file and line relative to the project", () => {
    expect(
      overlayError(
        '[plugin:vite:import-analysis] Failed to resolve import "./x" from "src/App.tsx".',
        "/home/user/app/src/App.tsx:3:20",
      ),
    ).toEqual({
      kind: "build",
      message: '[plugin:vite:import-analysis] Failed to resolve import "./x" from "src/App.tsx".',
      file: "src/App.tsx",
      line: 3,
    });
  });

  it("keeps a location without a line as the file, and none as none", () => {
    expect(overlayError("Boom", "/home/user/app/src/main.tsx")).toMatchObject({
      file: "src/main.tsx",
      line: undefined,
    });
    expect(overlayError("Boom")).toEqual({ kind: "build", message: "Boom", file: undefined, line: undefined });
  });
});
