import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), connect: vi.fn() }));
/** The project in Convex, by path: what the repair agent's file tools read and write. */
const convexFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: e2b.create, list: e2b.list, connect: e2b.connect },
}));
vi.mock("@/lib/convex-client", () => ({
  convex: {
    // getProjectFilesWithUrls: root-level rows named by their whole path.
    query: vi.fn(async () =>
      [...convexFiles].map(([path, content], i) => ({ _id: `file_${i}`, name: path, type: "file", content })),
    ),
  },
}));
// The agent's Convex file tools, reduced to the in-memory project above. Their
// own behaviour is covered by their tests; these check the repair's wiring.
vi.mock("@/features/conversations/inngest/tools/read-files", () => ({
  createReadFilesTool: () =>
    fakeTool("readFiles", ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, content: convexFiles.get(path) ?? "Error: not found" })),
    ),
}));
vi.mock("@/features/conversations/inngest/tools/write-files", () => ({
  createWriteFilesTool: vi.fn(() =>
    fakeTool("writeFiles", ({ files }: { files: Array<{ path: string; content: string }> }) => {
      // Paths under locked/ fail, as a locked file does (#307).
      const ok = files.filter(({ path }) => !path.startsWith("locked/"));
      const failed = files.filter(({ path }) => path.startsWith("locked/")).map(({ path }) => `${path} (locked)`);
      for (const { path, content } of ok) convexFiles.set(path, content);
      if (ok.length === 0) return `Error: No files written. Failed: ${failed.join(", ")}.`;
      return [
        `Wrote ${ok.length} file(s).`,
        `Updated: ${ok.map(({ path }) => path).join(", ")}.`,
        failed.length ? `Failed: ${failed.join(", ")}.` : "",
      ].filter(Boolean).join(" ");
    })),
}));
vi.mock("@/features/conversations/inngest/tools/edit-file", () => ({
  createEditFileTool: vi.fn(() =>
    fakeTool("editFile", ({ path, edits }: { path: string; edits: Array<{ oldText: string; newText: string }> }) => {
      let content = convexFiles.get(path) ?? "";
      for (const { oldText, newText } of edits) {
        if (!content.includes(oldText)) return `Error: oldText not found in ${path}`;
        content = content.replace(oldText, newText);
      }
      convexFiles.set(path, content);
      return `Edited ${path}`;
    })),
}));
vi.mock("@/features/conversations/inngest/tools/delete-files", () => ({
  createDeleteFilesTool: vi.fn(() =>
    fakeTool("deleteFiles", ({ paths }: { paths: string[] }) => {
      paths.forEach((path) => convexFiles.delete(path));
      return `Deleted ${paths.join(", ")}`;
    })),
}));

import { createTool, openai } from "@inngest/agent-kit";
import { CommandExitError, type Sandbox as E2bSandbox } from "e2b";
import { z } from "zod";

import { REDACTION_UNAVAILABLE_NOTICE } from "@/features/integrations/server/env/stream-redactor";
import { fromE2bSandbox } from "@/features/sandbox-preview/server/provider/e2b";

import type { Id } from "../../../../convex/_generated/dataModel";
import { VITE_REACT_STARTER } from "../inngest/vite-starter";
import { type RepairEvent, parseBuildErrors, repairTools, verifyAndFix } from "./sandbox-repair";
import { createWriteFilesTool } from "../inngest/tools/write-files";
import { createEditFileTool } from "../inngest/tools/edit-file";
import { createDeleteFilesTool } from "../inngest/tools/delete-files";
import { trimBuildOutput } from "../inngest/tools/check-build";
import {
  NEXT16_MODULE_NOT_FOUND,
  NEXT16_PRERENDER_ERROR,
  NEXT16_SYNTAX_ERROR,
  NEXT16_TYPE_ERROR,
  NEXT_MODULE_NOT_FOUND,
  NEXT_PRERENDER_ERROR,
  NEXT_TYPE_ERROR,
} from "../inngest/tools/next-build-output.fixture";
import { START_BUILD_ERROR, START_TYPE_ERROR } from "../inngest/tools/start-build-output.fixture";
import {
  VITE8_BUILD_JSX_ERROR,
  VITE8_BUILD_SYNTAX_ERROR,
  VITE8_BUILD_UNRESOLVED_IMPORT,
} from "../inngest/tools/vite-build-output.fixture";

/** Like the real tools: the work runs in a step with a fixed id, when there is a step. */
function fakeTool<T>(name: string, handler: (input: T) => unknown) {
  return createTool({
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    handler: (input, { step }) => (step ? step.run(name, async () => handler(input as T)) : handler(input as T)),
  });
}

const DIR = "/home/user/app";
const SECRET = "sk_live_supersecret123";
const BROKEN_APP = "export default function App() {\n  const x: string = 1;\n  return null; // BROKEN\n}\n";
const FIXED_APP = "export default function App() {\n  return null;\n}\n";

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

/**
 * An in-memory sandbox: a file system shared by the project directory and the
 * check directories, and a build that fails on the first checked `src/` file
 * containing BROKEN. Convex starts with the same project.
 */
const fakeSandbox = ({
  install = () => ({ exitCode: 0 }),
  build = (broken: string | undefined, dir: string): Answer =>
    broken
      ? { exitCode: 2, stderr: `${dir}/${broken}(2,9): error TS2322: Type 'number' is not assignable to type 'string'.` }
      : { exitCode: 0 },
  find,
  extra = {},
}: {
  install?: (broken: string | undefined) => Answer;
  build?: (broken: string | undefined, dir: string, fs: Map<string, string>) => Answer;
  find?: () => Answer;
  extra?: Record<string, string>;
} = {}) => {
  const project: Record<string, string> = {
    ...Object.fromEntries(VITE_REACT_STARTER.map((file) => [file.path, file.content])),
    "src/App.tsx": BROKEN_APP,
    ...extra,
  };
  convexFiles.clear();
  const fs = new Map<string, string>();
  for (const [path, content] of Object.entries(project)) {
    convexFiles.set(path, content);
    fs.set(`${DIR}/${path}`, content);
  }
  fs.set(`${DIR}/.env`, `API_KEY=${SECRET}`);
  fs.set(`${DIR}/node_modules/react/index.js`, "module.exports = {}");
  const builds: Array<string | undefined> = [];
  const brokenIn = (dir: string) =>
    [...fs]
      .filter(([path, content]) => path.startsWith(`${dir}/src/`) && content.includes("BROKEN"))
      .map(([path]) => path.slice(dir.length + 1))[0];

  const answer = (result: Answer) => {
    if (result instanceof Error) throw result;
    const full = { stdout: "", stderr: "", ...result };
    if (full.exitCode !== 0) throw new CommandExitError(full);
    return full;
  };
  return {
    fs,
    builds,
    files: {
      makeDir: vi.fn(async () => true),
      exists: vi.fn(async (path: string) => fs.has(path)),
      remove: vi.fn(async (path: string) => {
        fs.delete(path);
      }),
      read: vi.fn(async (path: string, opts?: { format?: string }) => {
        const content = fs.get(path);
        if (content === undefined) throw new Error(`No such file: ${path}`);
        return opts?.format === "bytes" ? new TextEncoder().encode(content) : content;
      }),
      write: vi.fn(async (pathOrFiles: string | { path: string; data: string }[], data?: string) => {
        if (typeof pathOrFiles === "string") fs.set(pathOrFiles, data ?? "");
        else for (const file of pathOrFiles) fs.set(file.path, file.data);
        return {};
      }),
    },
    commands: {
      run: vi.fn(async (command: string, opts?: { cwd?: string }) => {
        const cwd = opts?.cwd ?? "";
        if (command.startsWith("find ")) {
          if (find) return answer(find());
          const stdout = [...fs]
            .filter(([path]) => path.startsWith(`${cwd}/`))
            .map(([path, content]) => `${content.length} ${path.slice(cwd.length + 1)}`)
            .join("\n");
          return answer({ exitCode: 0, stdout });
        }
        if (command.startsWith("npm install")) return answer(install(brokenIn(cwd)));
        const copy = /tar -C '([^']+)'.* \| tar -C (\S+) -xf -$/.exec(command);
        if (copy) {
          const [, from, to] = copy;
          for (const [path, content] of [...fs]) {
            const rel = path.slice(from.length + 1);
            if (path.startsWith(`${from}/`) && !/(^|\/)(node_modules|\.git|dist)\/|(^|\/)\.env/.test(rel)) {
              fs.set(`${to}/${rel}`, content);
            }
          }
          return answer({ exitCode: 0 });
        }
        if (command.includes("vite build")) {
          builds.push(brokenIn(cwd));
          return answer(build(brokenIn(cwd), cwd, fs));
        }
        // The provider helpers' exists and remove.
        const quoted = /^(test -e|rm -rf --) '([^']*)'/.exec(command);
        if (quoted) {
          const path = quoted[2];
          if (quoted[1] === "test -e") return answer({ exitCode: fs.has(path) ? 0 : 1 });
          fs.delete(path);
          return answer({ exitCode: 0 });
        }
        if (command.startsWith("rm -rf ")) {
          const dir = command.slice("rm -rf ".length);
          for (const path of [...fs.keys()]) if (path.startsWith(`${dir}/`)) fs.delete(path);
          return answer({ exitCode: 0 });
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    },
    kill: vi.fn(async () => {}),
  };
};

const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: "tool_calls",
  }],
});
const text = (content: string) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
});

/** The model's replies in order; each request it gets is recorded. */
const modelReplies = (...replies: Array<object | (() => object)>) => {
  const requests: Array<{ messages: Array<{ content: unknown }> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    const next = replies.shift();
    if (!next) throw new Error("No model reply left");
    return new Response(JSON.stringify(typeof next === "function" ? next() : next));
  }));
  return requests;
};

const model = openai({ model: "stub-haiku", apiKey: "test-key", baseUrl: "http://model.test/v1/" });

const run = (sandbox: ReturnType<typeof fakeSandbox>, options: Partial<Parameters<typeof verifyAndFix>[0]> = {}) => {
  const events: RepairEvent[] = [];
  return verifyAndFix({
    sandbox: fromE2bSandbox(sandbox as unknown as E2bSandbox),
    projectId: "proj_1" as Id<"projects">,
    internalKey: "internal",
    runId: "run_1",
    agentTaskId: "task_a",
    model,
    secrets: [SECRET],
    onEvent: (event) => {
      events.push(event);
    },
    ...options,
  }).then((result) => ({ result, events }));
};

const fixApp = () => [
  toolCall("readFiles", { paths: ["src/App.tsx"] }),
  toolCall("editFile", {
    path: "src/App.tsx",
    edits: [{ oldText: "  const x: string = 1;\n  return null; // BROKEN\n", newText: "  return null;\n" }],
  }),
  text("Removed the wrong assignment."),
];
const rewriteApp = (n: number) => [
  toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: `${BROKEN_APP}// try ${n}\n` }] }),
  text("Tried again."),
];

/** Nothing outside the caller's sandbox was touched, and it was left running. */
const expectSandboxKept = (sandbox: ReturnType<typeof fakeSandbox>) => {
  expect(sandbox.kill).not.toHaveBeenCalled();
  expect(e2b.create).not.toHaveBeenCalled();
  expect(e2b.list).not.toHaveBeenCalled();
  expect(e2b.connect).not.toHaveBeenCalled();
  // Every check directory was removed; the project directory is still there.
  expect([...sandbox.fs.keys()].filter((path) => path.startsWith("/home/user/check-build-"))).toEqual([]);
  expect(sandbox.fs.get(`${DIR}/.env`)).toBe(`API_KEY=${SECRET}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyAndFix", () => {
  it.each([undefined, "assistant-message" as Id<"messages">])(
    "threads the optional message id %s through verify and repair without using runId",
    async (messageId) => {
      const sandbox = fakeSandbox();
      modelReplies(...fixApp());
      await run(sandbox, { runId: "inngest-run", messageId });
      for (const factory of [createWriteFilesTool, createEditFileTool, createDeleteFilesTool]) {
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ messageId }));
      }
    },
  );

  it.each([
    {
      kind: "type",
      sandbox: () => fakeSandbox(),
      error: { file: "src/App.tsx", line: 2, kind: "type" },
    },
    {
      kind: "build",
      sandbox: () =>
        fakeSandbox({
          build: (broken, dir) =>
            broken ? { exitCode: 1, stderr: `${dir}/${broken}:3:3: ERROR: Unexpected "BROKEN"` } : { exitCode: 0 },
        }),
      error: { file: "src/App.tsx", line: 3, kind: "build" },
    },
    {
      kind: "install",
      sandbox: () =>
        fakeSandbox({
          install: (broken) =>
            broken
              ? { exitCode: 1, stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/nope" }
              : { exitCode: 0 },
        }),
      error: { kind: "install" },
    },
  ])("repairs a $kind failure in Convex, copies it into the sandbox and re-checks", async ({ sandbox: make, error }) => {
    const sandbox = make();
    const requests = modelReplies(...fixApp());

    const { result, events } = await run(sandbox);

    expect(result).toEqual({ ok: true, status: "verified", errors: [], filesChanged: ["src/App.tsx"], attempts: 1 });
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0].messages)).toContain("src/App.tsx");
    // The project the user sees has the fix, and so does the sandbox it was checked in.
    expect(convexFiles.get("src/App.tsx")).toBe(FIXED_APP);
    expect(sandbox.fs.get(`${DIR}/src/App.tsx`)).toBe(FIXED_APP);
    expect(sandbox.builds).toHaveLength(error.kind === "install" ? 1 : 2);
    expect(events.map(({ id, status }) => `${id} ${status}`)).toEqual([
      "run_1:task_a:verify:1 running",
      "run_1:task_a:verify:1 error",
      "run_1:task_a:repair:1 running",
      "run_1:task_a:repair:1 done",
      "run_1:task_a:verify:2 running",
      "run_1:task_a:verify:2 done",
    ]);
    expect(events[1].errors?.[0]).toMatchObject(error);
    expectSandboxKept(sandbox);
  });

  it("connects a lazy sandbox only to check or sync, and reports each repair response", async () => {
    const sandbox = fakeSandbox();
    modelReplies(...fixApp());
    const connect = vi.fn(async () => fromE2bSandbox(sandbox as unknown as E2bSandbox));
    const responses: Array<string | undefined> = [];

    const { result } = await run(sandbox, {
      sandbox: connect,
      onResponse: async (raw) => {
        responses.push(raw);
      },
    });

    expect(result).toMatchObject({ status: "verified", attempts: 1 });
    // verify:1, sync:1, verify:2
    expect(connect).toHaveBeenCalledTimes(3);
    expect(responses).toHaveLength(3);
    expect(JSON.parse(responses[0] ?? "{}")).toHaveProperty("choices");
  });

  it("reports a sandbox it cannot connect to as unverified, without repairing", async () => {
    const requests = modelReplies();

    const { result } = await run(fakeSandbox(), { sandbox: async () => Promise.reject(new Error("sandbox gone")) });

    expect(result).toMatchObject({ status: "unverified", attempts: 0, reason: expect.stringContaining("sandbox gone") });
    expect(requests).toHaveLength(0);
  });

  it("mirrors a repair's deletes into the sandbox", async () => {
    const sandbox = fakeSandbox({ extra: { "src/App.tsx": FIXED_APP, "src/Old.tsx": "// BROKEN" } });
    modelReplies(toolCall("deleteFiles", { paths: ["src/Old.tsx"] }), text("Deleted the stale file."));

    const { result } = await run(sandbox);

    expect(result).toMatchObject({ status: "verified", filesChanged: ["src/Old.tsx"] });
    expect(convexFiles.has("src/Old.tsx")).toBe(false);
    expect(sandbox.fs.has(`${DIR}/src/Old.tsx`)).toBe(false);
  });

  it("stops after the repair cap when the build keeps failing", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(...rewriteApp(1), ...rewriteApp(2), ...rewriteApp(3));

    const { result } = await run(sandbox);

    expect(result).toMatchObject({ ok: false, status: "failed", attempts: 3, filesChanged: ["src/App.tsx"] });
    expect(result.reason).toContain("after 3 repair attempt(s)");
    expect(result.errors[0]).toMatchObject({ file: "src/App.tsx", kind: "type" });
    expect(requests).toHaveLength(6);
    expect(sandbox.builds).toHaveLength(4);
    expectSandboxKept(sandbox);
  });

  it.each([10, NaN, Infinity])("caps maxAttempts %s at three", async (maxAttempts) => {
    modelReplies(...rewriteApp(1), ...rewriteApp(2), ...rewriteApp(3));
    const { result } = await run(fakeSandbox(), { maxAttempts });
    expect(result.attempts).toBe(3);
  });

  it("builds files too large to read, from the in-sandbox copy", async () => {
    const big = "x".repeat(1_000_001);
    const sandbox = fakeSandbox({
      extra: { "src/App.tsx": FIXED_APP, "src/big.json": big },
      build: (_broken, dir, fs) =>
        fs.get(`${dir}/src/big.json`) === big ? { exitCode: 0 } : { exitCode: 1, stderr: "Could not load src/big.json" },
    });

    const { result } = await run(sandbox);

    expect(result.status).toBe("verified");
    expect(sandbox.files.read.mock.calls.map(([path]) => path)).not.toContain(`${DIR}/src/big.json`);
  });

  it("reports an npm registry or network failure as unverified, never repairing it", async () => {
    const sandbox = fakeSandbox({
      install: () => ({ exitCode: 1, stderr: "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/react" }),
    });
    const requests = modelReplies();

    const { result } = await run(sandbox);

    expect(result).toMatchObject({ status: "unverified", attempts: 0 });
    expect(result.reason).toMatch(/^Error: The build check could not finish/);
    expect(requests).toHaveLength(0);
  });

  describe("with a fallback model", () => {
    const main = openai({ model: "stub-main", apiKey: "test-key", baseUrl: "http://model.test/v1/" });
    const modelsOf = (requests: unknown[]) => (requests as Array<{ model: string }>).map((request) => request.model);

    it("repairs on the cheap model first, with the failing file in its prompt, then escalates", async () => {
      const sandbox = fakeSandbox();
      const requests = modelReplies(...rewriteApp(1), ...rewriteApp(2), ...fixApp());
      const onFallback: boolean[] = [];

      const { result } = await run(sandbox, {
        maxAttempts: 3,
        fallback: { model: main, after: 2 },
        onResponse: async (_raw, fallback) => {
          onFallback.push(fallback);
        },
      });

      expect(result).toMatchObject({ ok: true, status: "verified", attempts: 3, filesChanged: ["src/App.tsx"] });
      expect(modelsOf(requests)).toEqual(["stub-haiku", "stub-haiku", "stub-haiku", "stub-haiku", "stub-main", "stub-main", "stub-main"]);
      expect(onFallback).toEqual([false, false, false, false, true, true, true]);
      // Only the errors and the files they name: the prompt shows the file, so no read is needed first.
      const prompt = JSON.stringify(requests[0].messages);
      expect(prompt).toContain("Current content of files the errors name");
      expect(prompt).toContain("return null; // BROKEN");
    });

    it("stays on the cheap model when it fixes the build", async () => {
      const requests = modelReplies(...fixApp());

      const { result } = await run(fakeSandbox(), { maxAttempts: 3, fallback: { model: main, after: 2 } });

      expect(result).toMatchObject({ status: "verified", attempts: 1 });
      expect(modelsOf(requests)).toEqual(["stub-haiku", "stub-haiku", "stub-haiku"]);
    });

    it("hands a repair that changed nothing to the fallback at once, without checking again", async () => {
      const sandbox = fakeSandbox();
      const requests = modelReplies(
        toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: BROKEN_APP }] }),
        text("Looks fine to me."),
        ...fixApp(),
      );

      const { result, events } = await run(sandbox, { maxAttempts: 3, fallback: { model: main, after: 2 } });

      expect(result).toMatchObject({ status: "verified", attempts: 2, filesChanged: ["src/App.tsx"] });
      expect(modelsOf(requests)).toEqual(["stub-haiku", "stub-haiku", "stub-main", "stub-main", "stub-main"]);
      expect(sandbox.builds).toHaveLength(2);
      expect(events.map(({ id, status }) => `${id} ${status}`)).toEqual([
        "run_1:task_a:verify:1 running",
        "run_1:task_a:verify:1 error",
        "run_1:task_a:repair:1 running",
        "run_1:task_a:repair:1 error",
        "run_1:task_a:repair:2 running",
        "run_1:task_a:repair:2 done",
        "run_1:task_a:verify:3 running",
        "run_1:task_a:verify:3 done",
      ]);
    });

    it("hands a repair whose model call fails to the fallback, without checking again", async () => {
      const sandbox = fakeSandbox();
      const requests = modelReplies(() => {
        throw new Error("cheap model unavailable");
      }, ...fixApp());

      const { result, events } = await run(sandbox, { maxAttempts: 3, fallback: { model: main, after: 2 } });

      expect(result).toMatchObject({ status: "verified", attempts: 2, filesChanged: ["src/App.tsx"] });
      expect(modelsOf(requests)).toEqual(["stub-haiku", "stub-main", "stub-main", "stub-main"]);
      expect(sandbox.builds).toHaveLength(2);
      expect(events.filter(({ id }) => id === "run_1:task_a:repair:1").at(-1)).toMatchObject({
        status: "error",
        reason: expect.stringContaining("Repair could not run"),
      });
    });

    it("fails once the fallback's own repair changes nothing", async () => {
      const unchanged = () => [
        toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: BROKEN_APP }] }),
        text("Looks fine to me."),
      ];
      const requests = modelReplies(...unchanged(), ...unchanged());

      const { result } = await run(fakeSandbox(), { maxAttempts: 3, fallback: { model: main, after: 2 } });

      expect(result).toMatchObject({ ok: false, status: "failed", reason: "Repair made no changes", attempts: 2 });
      expect(modelsOf(requests)).toEqual(["stub-haiku", "stub-haiku", "stub-main", "stub-main"]);
    });
  });

  it("fails a repair that changed nothing instead of checking again", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(
      toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: BROKEN_APP }] }),
      text("Looks fine to me."),
    );

    const { result, events } = await run(sandbox);

    expect(result).toMatchObject({ ok: false, status: "failed", reason: "Repair made no changes", filesChanged: [], attempts: 1 });
    expect(requests).toHaveLength(2);
    expect(sandbox.builds).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ id: "run_1:task_a:repair:1", status: "error" });
  });

  it("refuses writes and deletes outside allowedPaths, applying none of them", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(
      toolCall("writeFiles", {
        files: [
          { path: "src/mine/Panel.tsx", content: "export const Panel = 1;\n" },
          { path: "src/App.tsx", content: FIXED_APP },
        ],
      }),
      toolCall("deleteFiles", { paths: ["src/App.tsx"] }),
      text("Could not fix it within my files."),
    );

    const { result } = await run(sandbox, { allowedPaths: (path) => path.startsWith("src/mine/"), maxAttempts: 1 });

    expect(result).toMatchObject({ status: "failed", reason: "Repair made no changes" });
    const toolResults = JSON.stringify(requests.slice(1).map(({ messages }) => messages.at(-1)));
    expect(toolResults).toContain("Error: src/App.tsx is outside this task's files");
    expect(convexFiles.get("src/App.tsx")).toBe(BROKEN_APP);
    expect(convexFiles.has("src/mine/Panel.tsx")).toBe(false);
    expect(sandbox.fs.get(`${DIR}/src/App.tsx`)).toBe(BROKEN_APP);
  });

  it("never lets a repair edit the generated route tree", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(
      toolCall("writeFiles", { files: [{ path: "src/routeTree.gen.ts", content: "// edited\n" }] }),
      text("Could not edit it."),
    );

    const { result } = await run(sandbox, { maxAttempts: 1 });

    expect(result).toMatchObject({ status: "failed", reason: "Repair made no changes" });
    expect(JSON.stringify(requests.slice(1).map(({ messages }) => messages.at(-1)))).toContain(
      "Error: src/routeTree.gen.ts is outside this task's files",
    );
    expect(convexFiles.has("src/routeTree.gen.ts")).toBe(false);
  });

  it("checks without repairing when maxAttempts is 0", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies();

    const { result } = await run(sandbox, { maxAttempts: 0 });

    expect(result).toMatchObject({ status: "failed", attempts: 0, filesChanged: [] });
    expect(result.errors[0]).toMatchObject({ file: "src/App.tsx" });
    expect(requests).toHaveLength(0);
    expect(sandbox.builds).toHaveLength(1);
  });

  it("stops a check at the caller's deadline instead of its own 240 s budget (#649)", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies();

    const { result } = await run(sandbox, { deadline: Date.now() - 1 });

    expect(result).toMatchObject({ status: "unverified", attempts: 0 });
    expect(result.reason).toMatch(/could not finish/);
    expect(sandbox.builds).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["the check cannot finish", () => fakeSandbox({ install: () => new Error("sandbox connection reset") })],
    ["the sandbox's files cannot be listed", () => fakeSandbox({ find: () => new Error("sandbox gone") })],
  ])("reports unverified, without repairing, when %s", async (_case, make) => {
    const sandbox = make();
    const requests = modelReplies();

    const { result, events } = await run(sandbox);

    expect(result).toMatchObject({ ok: false, status: "unverified", errors: [], attempts: 0 });
    expect(result.reason).toBeTruthy();
    expect(requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ phase: "verify", status: "error" });
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("reports scoped-ok, never verified, when only filtered-out errors remain", async () => {
    const requests = modelReplies();

    const { result, events } = await run(fakeSandbox(), {
      filterErrors: (errors) => errors.filter(({ file }) => file?.startsWith("src/mine/")),
    });

    expect(result.status).toBe("scoped-ok");
    expect(result.ok).toBe(false);
    // The full build's errors are still reported.
    expect(result.errors[0]).toMatchObject({ file: "src/App.tsx", kind: "type" });
    expect(events.at(-1)).toMatchObject({ phase: "verify", reason: "Only filtered-out errors remain" });
    expect(requests).toHaveLength(0);
  });

  it("does not check or repair once cancelled", async () => {
    const sandbox = fakeSandbox();
    const controller = new AbortController();
    controller.abort();

    const { result } = await run(sandbox, { signal: controller.signal });

    expect(result).toMatchObject({ status: "unverified", reason: "Cancelled" });
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("refuses the repair's writes after a cancel during its model call, and stops", async () => {
    const sandbox = fakeSandbox();
    const controller = new AbortController();
    const requests = modelReplies(() => {
      controller.abort();
      return toolCall("writeFiles", { files: [{ path: "src/App.tsx", content: FIXED_APP }] });
    });

    const { result } = await run(sandbox, { signal: controller.signal });

    expect(result).toMatchObject({ status: "unverified", reason: "Cancelled", filesChanged: [] });
    expect(requests).toHaveLength(1);
    expect(convexFiles.get("src/App.tsx")).toBe(BROKEN_APP);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("runs each verify and sync as a step with a deterministic id, and replays memoized outcomes", async () => {
    const memo = new Map<string, unknown>();
    const ids: string[] = [];
    const step = async (id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      if (!memo.has(id)) memo.set(id, JSON.parse(JSON.stringify(await fn())));
      return memo.get(id);
    };
    const expected = ["run_1:task_a:verify:1", "run_1:task_a:sync:1", "run_1:task_a:verify:2"];

    modelReplies(...fixApp());
    const { result } = await run(fakeSandbox(), { step });
    expect(result.status).toBe("verified");
    expect(ids).toEqual(expected);

    // A replay: every step comes from the memo, so no build runs again.
    const replay = fakeSandbox();
    modelReplies(...fixApp());
    ids.length = 0;
    const { result: replayed } = await run(replay, { step });
    expect(replayed).toEqual(result);
    expect(ids).toEqual(expected);
    expect(replay.builds).toEqual([]);
  });

  it("keeps the project's secrets out of errors, events and the model's prompt", async () => {
    const sandbox = fakeSandbox({
      build: (broken, dir) =>
        broken ? { exitCode: 2, stderr: `${dir}/${broken}(2,9): error TS2322: bad value ${SECRET}` } : { exitCode: 0 },
    });
    const requests = modelReplies(...fixApp());

    const { result, events } = await run(sandbox);

    expect(result.status).toBe("verified");
    expect(JSON.stringify({ result, events, requests })).not.toContain(SECRET);
    expect(JSON.stringify(events)).toContain("TS2322");
    // The sandbox's `.env` is never read into a check.
    expect(sandbox.files.read.mock.calls.map(([path]) => path)).not.toContain(`${DIR}/.env`);
    const written = sandbox.files.write.mock.calls.flatMap(([target]) =>
      typeof target === "string" ? [target] : target.map((file) => file.path),
    );
    expect(written.filter((path) => path.endsWith(".env"))).toEqual([]);
  });
});

describe("verifyAndFix redaction wiring", () => {
  const ENCODED = Buffer.from(SECRET).toString("base64");

  it("leaves out of the prompt a named file holding a base64-encoded value", async () => {
    const sandbox = fakeSandbox({ extra: { "src/App.tsx": `${BROKEN_APP}export const key = "${ENCODED}";\n` } });
    const requests = modelReplies(...fixApp());

    await run(sandbox, { maxAttempts: 1 });

    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain("TS2322");
    expect(prompt).not.toContain("Current content of files the errors name");
    expect(prompt).not.toContain(ENCODED);
  });

  it("redacts an encoded value from a failure's reason, keeping its fixed text", async () => {
    const { result, events } = await run(fakeSandbox({ find: () => new Error(`find: ${ENCODED}`) }));

    expect(result.reason).toBe("Could not read the sandbox's files (find: [redacted])");
    expect(JSON.stringify(events)).not.toContain(ENCODED);
  });

  it("hides the check's output when the values are unknown", async () => {
    const sandbox = fakeSandbox({ build: (_broken, dir) => ({ exitCode: 2, stderr: `${dir}/src/App.tsx(2,9): ${SECRET}` }) });

    const { result, events } = await run(sandbox, { secrets: null, maxAttempts: 0 });

    expect(result.errors).toEqual([{ message: REDACTION_UNAVAILABLE_NOTICE, kind: "build" }]);
    expect(JSON.stringify({ result, events })).not.toContain("src/App.tsx(2,9)");
  });

  it("still reads a static failure as static when a 3-character value occurs in its prefix", async () => {
    const sandbox = fakeSandbox({ extra: { "src/pages/Home.tsx": 'import { Chart } from "../components/Statistics";\n' } });

    const { result } = await run(sandbox, { secrets: ["tic"], maxAttempts: 0 });

    expect(result.errors).toEqual([expect.objectContaining({ kind: "static", message: expect.stringContaining("Statis[redacted]s") })]);
  });
});

describe("repairTools", () => {
  const tools = (name: string, written: string[] = [], allowedPaths?: (path: string) => boolean) =>
    Object.fromEntries(
      repairTools({ projectId: "proj_1" as Id<"projects">, internalKey: "internal", name, written, allowedPaths }).map(
        (tool) => [tool.name, tool],
      ),
    );
  const call = (tool: { handler: (input: never, opts: never) => unknown }, input: object, step?: object) =>
    tool.handler(input as never, { step } as never);

  it("puts every file tool step under its worker's name, so parallel workers never share one", async () => {
    const ids: string[] = [];
    const step = { run: async (id: string, fn: () => Promise<unknown>) => (ids.push(id), fn()) };
    convexFiles.clear();
    const input = { files: [{ path: "src/a.ts", content: "a" }] };

    await call(tools("run_1:task_a:repair:1").writeFiles, input, step);
    await call(tools("run_1:task_b:repair:1").writeFiles, input, step);
    await call(tools("run_1:task_a:repair:1").readFiles, { paths: ["src/a.ts"] }, step);

    expect(ids).toEqual([
      "run_1:task_a:repair:1:writeFiles",
      "run_1:task_b:repair:1:writeFiles",
      "run_1:task_a:repair:1:readFiles",
    ]);
  });

  it("refuses write calls that name no path, such as deletes by file id", async () => {
    convexFiles.clear();
    convexFiles.set("src/a.ts", "a");
    const written: string[] = [];

    const result = await call(tools("w", written).deleteFiles, { fileIds: ["file_0"] });

    expect(result).toBe("Error: Name the files to change by path.");
    expect(convexFiles.has("src/a.ts")).toBe(true);
    expect(written).toEqual([]);
  });

  it("checks JSON-string arrays against allowedPaths like real ones", async () => {
    convexFiles.clear();
    convexFiles.set("src/App.tsx", "app");
    const written: string[] = [];
    const scoped = tools("w", written, (path) => path.startsWith("src/mine/"));

    expect(await call(scoped.deleteFiles, { paths: '["src/App.tsx"]' })).toBe("Error: src/App.tsx is outside this task's files");
    expect(convexFiles.has("src/App.tsx")).toBe(true);
    const files = JSON.stringify([{ path: "src/mine/a.ts", content: "a" }]);
    expect(await call(scoped.writeFiles, { files })).toBe("Wrote 1 file(s). Updated: src/mine/a.ts.");
    expect(written).toEqual(["src/mine/a.ts"]);
  });

  it("counts only the files a partial writeFiles wrote", async () => {
    convexFiles.clear();
    const written: string[] = [];

    const result = await call(tools("w", written).writeFiles, {
      files: [{ path: "src/a.ts", content: "a" }, { path: "locked/b.ts", content: "b" }],
    });

    expect(result).toContain("Failed: locked/b.ts");
    expect(written).toEqual(["src/a.ts"]);
  });
});

describe("parseBuildErrors", () => {
  it("reads static, tsc and esbuild failures", () => {
    expect(parseBuildErrors("Error: Static checks failed:\n- ./x (imported by src/a.ts)\nFix these, then call checkBuild again.")).toEqual([
      { message: "./x (imported by src/a.ts)", kind: "static" },
    ]);
    expect(parseBuildErrors("Error: Build failed. Fix these errors, then call checkBuild again:\nsrc/a.ts(1,2): error TS1005: ';' expected.\nFound 1 error.")).toEqual([
      { file: "src/a.ts", line: 1, message: "error TS1005: ';' expected.", kind: "type" },
    ]);
    expect(parseBuildErrors("Error: Build failed. Fix these errors, then call checkBuild again:\nsomething broke")).toEqual([
      { message: "something broke", kind: "build" },
    ]);
  });

  /** checkBuild's failure text for a captured `next build` output. */
  const nextFailure = ({ stdout, stderr }: { stdout: string; stderr: string }) =>
    "Error: Build failed. Fix these errors, then call checkBuild again:\n" +
    trimBuildOutput(`${stderr}\n${stdout}`, "/home/user/app", "next");

  it.each([
    [VITE8_BUILD_UNRESOLVED_IMPORT, 1, "[UNRESOLVED_IMPORT] Could not resolve './components/Missing' in src/App.tsx"],
    [VITE8_BUILD_SYNTAX_ERROR, 2, "[builtin:vite-transform] Unexpected token"],
    [VITE8_BUILD_JSX_ERROR, 2, "[builtin:vite-transform] Expected corresponding JSX closing tag for 'h1'."],
  ])("reads a Vite 8 build error from its code frame (line %#)", (output, line, message) => {
    const text = "Error: Build failed. Fix these errors, then call checkBuild again:\n" + trimBuildOutput(output, "/home/user/app");
    expect(parseBuildErrors(text)).toEqual([{ file: "src/App.tsx", line, message, kind: "build" }]);
  });

  it("reads a Next.js type error from its location line and the message after it", () => {
    expect(parseBuildErrors(nextFailure(NEXT_TYPE_ERROR))).toEqual([
      { file: "src/app/page.tsx", line: 12, message: "Type error: Type 'number' is not assignable to type 'string'.", kind: "type" },
    ]);
  });

  it("reads a Next.js missing module", () => {
    expect(parseBuildErrors(nextFailure(NEXT_MODULE_NOT_FOUND))).toEqual([
      { file: "src/app/page.tsx", line: 3, message: "Module not found: Can't resolve '@/components/Hero'", kind: "build" },
    ]);
  });

  it("reads a Next.js location without a line", () => {
    const text = "Error: Build failed. Fix these errors, then call checkBuild again:\nFailed to compile.\n./src/app/page.tsx\nModule not found: Can't resolve 'zod'";
    expect(parseBuildErrors(text)).toEqual([
      { file: "src/app/page.tsx", message: "Module not found: Can't resolve 'zod'", kind: "build" },
    ]);
  });

  /** checkBuild's failure text for a modelled TanStack Start `vite build && tsc` output. */
  const startFailure = ({ stdout, stderr }: { stdout: string; stderr: string }) =>
    "Error: Build failed. Fix these errors, then call checkBuild again:\n" +
    trimBuildOutput(`${stderr}\n${stdout}`, "/home/user/app", "tanstack-start");

  it("reads a TanStack Start type error found by tsc after the build", () => {
    expect(parseBuildErrors(startFailure(START_TYPE_ERROR))).toEqual([
      { file: "src/routes/index.tsx", line: 12, message: "error TS2322: Type 'number' is not assignable to type 'string'.", kind: "type" },
    ]);
  });

  it("keeps a TanStack Start vite build failure whole", () => {
    const [error] = parseBuildErrors(startFailure(START_BUILD_ERROR));
    expect(error.kind).toBe("build");
    expect(error.message).toMatch(/^error during build:\n\[vite\]: Rollup failed to resolve import "@\/components\/Hero"/);
  });

  it.each([
    [NEXT16_TYPE_ERROR, { file: "src/app/page.tsx", line: 8, message: "error TS2322: Type 'number' is not assignable to type 'string'.", kind: "type" }],
    [NEXT16_MODULE_NOT_FOUND, { file: "src/app/page.tsx", line: 3, message: "Error: Module not found: Can't resolve '@/components/Hero'", kind: "build" }],
    [NEXT16_SYNTAX_ERROR, { file: "src/app/page.tsx", line: 6, message: "Error: Expected ',', got ';'", kind: "build" }],
  ])("reads a Next 16 (Turbopack) failure: %#", (fixture, error) => {
    expect(parseBuildErrors(nextFailure(fixture))).toEqual([error]);
  });

  it("keeps a Next 16 prerender failure whole, with its source frame", () => {
    const [error] = parseBuildErrors(nextFailure(NEXT16_PRERENDER_ERROR));
    expect(error).toMatchObject({ kind: "build" });
    expect(error.message).toMatch(/^Error occurred prerendering page "\/"[^\n]*\nError: STRIPE_SECRET_KEY is not set\n {4}at <unknown> \(src\/app\/page\.tsx:2:45\)/);
  });

  it("keeps a Next.js prerender failure whole: it names no source file", () => {
    const [error] = parseBuildErrors(nextFailure(NEXT_PRERENDER_ERROR));
    expect(error.kind).toBe("build");
    expect(error.file).toBeUndefined();
    expect(error.message).toMatch(/^Error occurred prerendering page "\/"[^\n]*\nError: STRIPE_SECRET_KEY is not set/);
  });
});
