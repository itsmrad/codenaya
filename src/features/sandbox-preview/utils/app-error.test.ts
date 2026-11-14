import { describe, expect, it } from "vitest";

import {
  appErrorKey,
  bannerError,
  buildFixPrompt,
  createBuildErrorDetector,
  codeBlock,
  detectBuildError,
  isHmrSuccess,
  logTail,
  mergeAppError,
  trackFixAttempts,
} from "./app-error";

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

  it("reads a tsc error", () => {
    expect(
      detectBuildError("src/App.tsx(3,20): error TS2307: Cannot find module './Missing'.\n"),
    ).toMatchObject({ file: "src/App.tsx", line: 3 });
  });

  it("ignores ordinary output", () => {
    expect(detectBuildError("  VITE v6.0.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n")).toBeNull();
    expect(detectBuildError("[vite] hmr update /src/App.jsx\n")).toBeNull();
  });
});

describe("isHmrSuccess", () => {
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
