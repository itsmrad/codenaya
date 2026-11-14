import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), connect: vi.fn() }));

vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: { create: e2b.create, list: e2b.list, connect: e2b.connect },
}));
vi.mock("@/lib/convex-client", () => ({ convex: { query: vi.fn() } }));

import { openai } from "@inngest/agent-kit";
import { CommandExitError, type Sandbox } from "e2b";

import { VITE_REACT_STARTER } from "../inngest/vite-starter";
import { type RepairEvent, parseBuildErrors, verifyAndFix } from "./sandbox-repair";

const DIR = "/home/user/app";
const SECRET = "sk_live_supersecret123";
const BROKEN_APP = "export default function App() {\n  const x: string = 1;\n  return null; // BROKEN\n}\n";
const FIXED_APP = "export default function App() {\n  return null;\n}\n";

type Answer = { exitCode: number; stdout?: string; stderr?: string } | Error;

/**
 * An in-memory sandbox: a file system shared by the project directory and the
 * check directories, and a build that fails while the checked App has BROKEN.
 */
const fakeSandbox = ({
  install = () => ({ exitCode: 0 }),
  build = (app: string, dir: string): Answer =>
    app.includes("BROKEN")
      ? { exitCode: 2, stderr: `${dir}/src/App.tsx(2,9): error TS2322: Type 'number' is not assignable to type 'string'.` }
      : { exitCode: 0 },
  find,
}: {
  install?: (dir: string) => Answer;
  build?: (app: string, dir: string) => Answer;
  find?: () => Answer;
} = {}) => {
  const fs = new Map<string, string>();
  for (const file of VITE_REACT_STARTER) fs.set(`${DIR}/${file.path}`, file.content);
  fs.set(`${DIR}/src/App.tsx`, BROKEN_APP);
  fs.set(`${DIR}/.env`, `API_KEY=${SECRET}`);
  fs.set(`${DIR}/node_modules/react/index.js`, "module.exports = {}");
  const builtApps: string[] = [];

  const answer = (result: Answer) => {
    if (result instanceof Error) throw result;
    const full = { stdout: "", stderr: "", ...result };
    if (full.exitCode !== 0) throw new CommandExitError(full);
    return full;
  };
  const sandbox = {
    fs,
    builtApps,
    files: {
      makeDir: vi.fn(async () => true),
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
        if (command.startsWith("npm install")) return answer(install(cwd));
        if (command.includes("vite build")) {
          const app = fs.get(`${cwd}/src/App.tsx`) ?? "";
          builtApps.push(app);
          return answer(build(app, cwd));
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
  return sandbox;
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
  const promise = verifyAndFix({
    sandbox: sandbox as unknown as Sandbox,
    projectId: "proj_1",
    runId: "run_1",
    agentTaskId: "task_a",
    model,
    secrets: [SECRET],
    onEvent: (event) => {
      events.push(event);
    },
    ...options,
  });
  return promise.then((result) => ({ result, events }));
};

const fixApp = () => [
  toolCall("readFiles", { paths: ["src/App.tsx"] }),
  toolCall("writeFile", { path: "src/App.tsx", content: FIXED_APP }),
  text("Removed the wrong assignment."),
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
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyAndFix", () => {
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
          build: (app, dir) =>
            app.includes("BROKEN") ? { exitCode: 1, stderr: `${dir}/src/App.tsx:3:3: ERROR: Unexpected "BROKEN"` } : { exitCode: 0 },
        }),
      error: { file: "src/App.tsx", line: 3, kind: "build" },
    },
    {
      kind: "install",
      sandbox: () => {
        const sandbox = fakeSandbox({
          install: (dir) =>
            sandbox.fs.get(`${dir}/src/App.tsx`)?.includes("BROKEN")
              ? { exitCode: 1, stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/nope" }
              : { exitCode: 0 },
        });
        return sandbox;
      },
      error: { kind: "install" },
    },
  ])("repairs a $kind failure with the model, then re-checks the sandbox's new files", async ({ sandbox: make, error }) => {
    const sandbox = make();
    const requests = modelReplies(...fixApp());

    const { result, events } = await run(sandbox);

    expect(result).toEqual({ ok: true, status: "verified", errors: [], filesChanged: ["src/App.tsx"], attempts: 1 });
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0].messages)).toContain("src/App.tsx");
    expect(sandbox.fs.get(`${DIR}/src/App.tsx`)).toBe(FIXED_APP);
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

  it("stops after the repair cap when the build keeps failing", async () => {
    const sandbox = fakeSandbox();
    const attempt = (n: number) => [
      toolCall("writeFile", { path: "src/App.tsx", content: `${BROKEN_APP}// try ${n}\n` }),
      text("Tried again."),
    ];
    const requests = modelReplies(...attempt(1), ...attempt(2), ...attempt(3));

    const { result } = await run(sandbox);

    expect(result).toMatchObject({ ok: false, status: "failed", attempts: 3, filesChanged: ["src/App.tsx"] });
    expect(result.reason).toContain("after 3 repair attempt(s)");
    expect(result.errors[0]).toMatchObject({ file: "src/App.tsx", kind: "type" });
    expect(requests).toHaveLength(6);
    expect(sandbox.builtApps).toHaveLength(4);
    expectSandboxKept(sandbox);
  });

  it("caps maxAttempts at three", async () => {
    const sandbox = fakeSandbox();
    const attempt = (n: number) => [
      toolCall("writeFile", { path: "src/App.tsx", content: `${BROKEN_APP}// try ${n}\n` }),
      text("Tried again."),
    ];
    modelReplies(...attempt(1), ...attempt(2), ...attempt(3));

    const { result } = await run(sandbox, { maxAttempts: 10 });

    expect(result.attempts).toBe(3);
  });

  it("fails a repair that changed nothing instead of checking again", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(
      toolCall("writeFile", { path: "src/App.tsx", content: BROKEN_APP }),
      text("Looks fine to me."),
    );

    const { result, events } = await run(sandbox);

    expect(result).toMatchObject({ ok: false, status: "failed", reason: "Repair made no changes", filesChanged: [], attempts: 1 });
    expect(requests).toHaveLength(2);
    expect(sandbox.builtApps).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ id: "run_1:task_a:repair:1", status: "error" });
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
    const sandbox = fakeSandbox();
    const requests = modelReplies();

    const { result } = await run(sandbox, {
      filterErrors: (errors) => errors.filter(({ file }) => file?.startsWith("src/mine/")),
    });

    expect(result.status).toBe("scoped-ok");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: "src/App.tsx" });
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
      return toolCall("writeFile", { path: "src/App.tsx", content: FIXED_APP });
    });

    const { result } = await run(sandbox, { signal: controller.signal });

    expect(result).toMatchObject({ status: "unverified", reason: "Cancelled", filesChanged: [] });
    expect(requests).toHaveLength(1);
    expect(sandbox.fs.get(`${DIR}/src/App.tsx`)).toBe(BROKEN_APP);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("runs each verify as a step with a deterministic id, and replays its memoized outcome", async () => {
    const memo = new Map<string, unknown>();
    const ids: string[] = [];
    const step = async <T>(id: string, fn: () => Promise<T>) => {
      ids.push(id);
      if (!memo.has(id)) memo.set(id, JSON.parse(JSON.stringify(await fn())));
      return memo.get(id) as T;
    };

    const first = fakeSandbox();
    modelReplies(...fixApp());
    const { result } = await run(first, { step });
    expect(result.status).toBe("verified");
    expect(ids).toEqual(["run_1:task_a:verify:1", "run_1:task_a:verify:2"]);

    // A replay: both verifies come from the memo, so no build runs again.
    const replay = fakeSandbox();
    modelReplies(...fixApp());
    ids.length = 0;
    await run(replay, { step });
    expect(ids).toEqual(["run_1:task_a:verify:1", "run_1:task_a:verify:2"]);
    expect(replay.builtApps).toEqual([]);
  });

  it("keeps the project's secrets out of errors, events and the model's prompt", async () => {
    const sandbox = fakeSandbox({
      build: (app, dir) =>
        app.includes("BROKEN")
          ? { exitCode: 2, stderr: `${dir}/src/App.tsx(2,9): error TS2322: bad value ${SECRET}` }
          : { exitCode: 0 },
    });
    const requests = modelReplies(...fixApp());

    const { result, events } = await run(sandbox);

    expect(result.status).toBe("verified");
    expect(JSON.stringify({ result, events, requests })).not.toContain(SECRET);
    expect(JSON.stringify(events)).toContain("TS2322");
    // `.env` is never read into a check or offered to the model.
    expect(sandbox.files.read.mock.calls.map(([path]) => path)).not.toContain(`${DIR}/.env`);
    const written = sandbox.files.write.mock.calls.flatMap(([target]) =>
      typeof target === "string" ? [target] : target.map((file) => file.path),
    );
    expect(written.filter((path) => path.endsWith(".env"))).toEqual([]);
  });

  it("refuses to read or write .env and paths outside the project", async () => {
    const sandbox = fakeSandbox();
    const requests = modelReplies(
      toolCall("readFiles", { paths: [".env"] }),
      toolCall("writeFile", { path: "../escape.ts", content: "x" }),
      text("Done."),
    );

    const { result } = await run(sandbox, { maxAttempts: 1 });

    expect(result).toMatchObject({ status: "failed", reason: "Repair made no changes" });
    expect(JSON.stringify(requests)).not.toContain(SECRET);
    expect(sandbox.fs.has("/home/user/escape.ts")).toBe(false);
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
});
