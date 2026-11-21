/**
 * The sandbox routes answer 400 for a malformed or invalid body, before they
 * touch Convex or E2B (#235).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxConnect: vi.fn(),
  sandboxList: vi.fn(),
  sandboxKill: vi.fn(),
  resolveProjectEnv: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query, mutation: mocks.mutation } }));
vi.mock("@/features/integrations/server/env/resolve-env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectEnv: mocks.resolveProjectEnv,
}));
// Real timers: a short debounce keeps the install tests fast.
vi.mock("@/features/sandbox-preview/server/debounce-serial", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  REINSTALL_DEBOUNCE_MS: 10,
}));
vi.mock("e2b", () => ({
  Sandbox: {
    create: mocks.sandboxCreate,
    connect: mocks.sandboxConnect,
    list: mocks.sandboxList,
    kill: mocks.sandboxKill,
  },
  AuthenticationError: class extends Error {},
  RateLimitError: class extends Error {},
  TimeoutError: class extends Error {},
  SandboxNotFoundError: class extends Error {},
  CommandExitError: class extends Error {
    constructor(
      readonly result: { exitCode: number; stdout?: string; stderr: string; error: string },
    ) {
      super(result.error);
    }
    get exitCode() {
      return this.result.exitCode;
    }
    get stdout() {
      return this.result.stdout ?? "";
    }
    get stderr() {
      return this.result.stderr;
    }
  },
}));

vi.mock("@/features/sandbox-preview/server/project-sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/sandbox-preview/server/project-sandbox")>();
  return {
    ...actual,
    atLiveSandboxCap: vi.fn(actual.atLiveSandboxCap),
    killProjectPreviews: vi.fn(actual.killProjectPreviews),
  };
});

import { CommandExitError, TimeoutError } from "e2b";
import { readInstallFailure } from "@/features/sandbox-preview/utils/app-error";
import { POST } from "./route";
import {
  SANDBOX_CREATE_RATE_LIMIT,
  checkRateLimit,
  resetRateLimits,
} from "@/lib/rate-limit";
import {
  DEFAULT_INSTALL_COMMAND,
  MAX_LIVE_SANDBOXES,
  atLiveSandboxCap,
  killProjectPreviews,
} from "@/features/sandbox-preview/server/project-sandbox";
import {
  DEV_COMMAND_ENV,
  DEV_START_COMMAND,
  READ_DEV_PGID_COMMAND,
  SHORT_CALL_MS,
  killProjectNodesCommand,
  killTreeCommand,
} from "@/features/sandbox-preview/server/dev-server";
import {
  forgetSandbox,
  requestReinstall,
} from "@/features/sandbox-preview/server/sandbox-registry";
import { REDACTION_UNAVAILABLE_NOTICE } from "@/features/integrations/server/env/stream-redactor";
import { PATCH } from "./[sandboxId]/route";

const cleanupBounds = { timeoutMs: SHORT_CALL_MS, requestTimeoutMs: SHORT_CALL_MS };

const params = { params: Promise.resolve({ sandboxId: "sbx_1" }) };

const request = (method: string, body: string) =>
  new Request("http://localhost/api/sandbox", { method, body });

const routes = [
  { name: "POST /api/sandbox", call: (body: string) => POST(request("POST", body)) },
  {
    name: "PATCH /api/sandbox/[sandboxId]",
    call: (body: string) => PATCH(request("PATCH", body), params),
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  resetRateLimits();
  vi.stubEnv("E2B_API_KEY", "e2b-test");
  mocks.auth.mockResolvedValue({ userId: "user_1" });
  // The runtime fence: no revoked runtimes, register answers a handle, admit admits.
  mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
    "sandboxId" in args ? [] : undefined,
  );
  mocks.mutation.mockImplementation(async (_ref, args: Record<string, unknown>) =>
    "handleId" in args ? "admitted" : "handle_1",
  );
});

afterEach(() => vi.unstubAllGlobals());

describe.each(routes)("$name", ({ call }) => {
  it.each([
    ["malformed JSON", "{not json"],
    ["a missing files array", "{}"],
    ["files that are not an array", '{"files":"index.js"}'],
    ["an empty files array", '{"files":[]}'],
    ["a file without content", '{"files":[{"path":"index.js"}]}'],
    // POST reads `settings.devCommand`, PATCH reads `installCommand`.
    [
      "a non-string command",
      '{"files":[{"path":"a.js","content":""}],"settings":{"devCommand":1},"installCommand":1}',
    ],
  ])("answers 400 for %s without touching Convex or E2B", async (_case, body) => {
    const res = await call(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
    expect(mocks.sandboxConnect).not.toHaveBeenCalled();
  });
});

describe("POST /api/sandbox cost caps (#242)", () => {
  const boot = () =>
    POST(request("POST", JSON.stringify({ files: [{ path: "index.html", content: "" }] })));
  const liveSandboxes = (count: number) =>
    mocks.sandboxList.mockReturnValue({
      nextItems: async () => Array.from({ length: count }, (_, i) => ({ sandboxId: `sbx_${i}` })),
    });

  it("answers 429 past the per-user rate limit without asking E2B", async () => {
    for (let i = 0; i < SANDBOX_CREATE_RATE_LIMIT.limit; i++) {
      checkRateLimit("user_1", SANDBOX_CREATE_RATE_LIMIT);
    }

    const res = await boot();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.sandboxList).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });

  it("answers 429 rate_limit when the user already has the max live sandboxes", async () => {
    liveSandboxes(MAX_LIVE_SANDBOXES);

    const res = await boot();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limit" });
    expect(mocks.sandboxList).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userId: "user_1" }, state: ["running"] },
      }),
    );
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });

  it("boots below the cap", async () => {
    liveSandboxes(MAX_LIVE_SANDBOXES - 1);
    mocks.sandboxCreate.mockRejectedValue(new Error("stop after the cap check"));

    const res = await boot();

    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.sandboxCreate).toHaveBeenCalled();
  });
});

describe("POST /api/sandbox tags (#465)", () => {
  const boot = (projectId?: string) =>
    POST(
      request(
        "POST",
        JSON.stringify({ files: [{ path: "index.html", content: "" }], projectId }),
      ),
    );

  beforeEach(() => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    mocks.sandboxCreate.mockRejectedValue(new Error("stop after create"));
  });

  it("tags a project's preview with its owner and project, so checkBuild can find it", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );

    await (await boot("proj_1")).text();

    expect(mocks.sandboxCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ metadata: { userId: "user_1", projectId: "proj_1" } }),
    );
  });

  it("tags a preview without a project with its owner only", async () => {
    await (await boot()).text();

    expect(mocks.sandboxCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ metadata: { userId: "user_1" } }),
    );
  });
});

describe("POST /api/sandbox past its time budget (#492)", () => {
  const boot = (extra: Record<string, unknown> = {}) =>
    POST(
      request(
        "POST",
        JSON.stringify({ files: [{ path: "index.html", content: "" }], ...extra }),
      ),
    );

  const events = async (res: Response) =>
    (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const fakeSandbox = (sandboxId: string, ownerId = "user_1") => ({
    sandboxId,
    getInfo: vi.fn(async () => ({ metadata: { userId: ownerId } })),
    kill: vi.fn(),
    commands: {
      list: vi.fn(async () => [{ pid: 7 }, { pid: 8 }]),
      kill: vi.fn(async () => true),
      run: vi.fn<(...args: unknown[]) => Promise<object>>(async () => {
        throw new Error("stop after connect");
      }),
    },
  });

  beforeEach(() => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the sandbox to the client to resume instead of failing it", async () => {
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const sandbox = fakeSandbox("sbx_slow");
    mocks.sandboxCreate.mockImplementation(async () => {
      now.mockReturnValue(startedAt + 280_000);
      return sandbox;
    });

    const sent = await events(await boot());

    expect(sent).toContainEqual({ type: "resume", sandboxId: "sbx_slow" });
    expect(sent.some((event) => event.type === "error")).toBe(false);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])("continues resuming after tree cleanup fails (wrapper kill fails: %s), without creating one or checking the cap", async (killFails) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sandbox = fakeSandbox("sbx_resume");
    if (killFails) sandbox.commands.kill.mockRejectedValue(new Error("wrapper kill failed"));
    mocks.sandboxConnect.mockResolvedValue(sandbox);

    await (await boot({ resumeSandboxId: "sbx_resume" })).text();

    expect(mocks.sandboxConnect).toHaveBeenCalledWith("sbx_resume", { apiKey: "e2b-test" });
    expect(sandbox.commands.run.mock.calls).toEqual([
      [READ_DEV_PGID_COMMAND, cleanupBounds],
      [killTreeCommand(7), { timeoutMs: 10_000 }],
      [killTreeCommand(8), { timeoutMs: 10_000 }],
      ["node --version", { timeoutMs: 10_000 }],
    ]);
    expect(sandbox.commands.kill.mock.calls).toEqual([
      [7, { requestTimeoutMs: 10_000 }],
      [8, { requestTimeoutMs: 10_000 }],
    ]);
    expect(warn.mock.calls).toEqual(killFails ? [
      ["[project-sandbox] Failed to stop command", 7],
      ["[project-sandbox] Failed to stop command", 8],
    ] : []);
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
    expect(mocks.sandboxList).not.toHaveBeenCalled();
  });

  it("answers a resume of a sandbox the provider no longer has like one it never had", async () => {
    const { SandboxNotFoundError } = await import("e2b");
    mocks.sandboxConnect.mockRejectedValue(new SandboxNotFoundError("Paused sandbox sbx_gone not found"));

    const sent = await events(await boot({ resumeSandboxId: "sbx_gone" }));

    expect(sent).toContainEqual(expect.objectContaining({ type: "error", message: "Sandbox not found" }));
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });

  it("stops every earlier command tree before resuming, including unmarked install and proxy commands", async () => {
    const sandbox = fakeSandbox("sbx_resume_tree");
    // Killing just the wrapper leaves its children alive, as with E2B.
    const children = new Set([70, 700]);
    let childrenAtBoot = children.size;
    const earlierCommands = [
      { pid: 7 },
      { pid: 8, envs: { [DEV_COMMAND_ENV]: "npm run dev" } },
      { pid: 9 },
    ];
    sandbox.commands.list.mockResolvedValue(earlierCommands);
    sandbox.commands.run.mockImplementation(async (command) => {
      if (command === killTreeCommand(7)) children.clear();
      if (command === "node --version") {
        childrenAtBoot = children.size;
        throw new Error("stop after cleanup");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mocks.sandboxConnect.mockResolvedValue(sandbox);

    await (await boot({ resumeSandboxId: "sbx_resume_tree" })).text();

    expect(childrenAtBoot).toBe(0);
    expect(sandbox.commands.run.mock.calls).toEqual([
      [READ_DEV_PGID_COMMAND, cleanupBounds],
      [killTreeCommand(8), cleanupBounds],
      [killProjectNodesCommand("/home/user/app"), cleanupBounds],
      [killTreeCommand(7), { timeoutMs: 10_000 }],
      [killTreeCommand(8), { timeoutMs: 10_000 }],
      [killTreeCommand(9), { timeoutMs: 10_000 }],
      ["node --version", { timeoutMs: 10_000 }],
    ]);
    expect(sandbox.commands.kill).not.toHaveBeenCalled();
  });

  it.each([
    ["hides the output of a resumed sandbox, which may still hold an earlier .env", "sbx_resume_env", true],
    ["shows the output of a new sandbox, which was given none", undefined, false],
  ])("%s, when its variables cannot be loaded", async (_case, resumeSandboxId, hidden) => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.resolveProjectEnv.mockRejectedValue(new Error("CODENAYA_LOCAL_KEK is not set"));
    mocks.sandboxConnect.mockResolvedValue(fakeSandbox("sbx_resume_env"));
    mocks.sandboxCreate.mockResolvedValue(fakeSandbox("sbx_new_env"));

    const sent = await events(await boot({ projectId: "proj_1", resumeSandboxId }));

    const output = sent.filter((event) => event.type === "output").map((event) => event.data);
    if (hidden) expect(new Set(output)).toEqual(new Set([REDACTION_UNAVAILABLE_NOTICE]));
    else expect(output.join("")).toContain("Sandbox sbx_new_env created.");
  });

  it("refuses to resume another user's sandbox", async () => {
    const sandbox = fakeSandbox("sbx_other", "user_2");
    mocks.sandboxConnect.mockResolvedValue(sandbox);

    const sent = await events(await boot({ resumeSandboxId: "sbx_other" }));

    expect(sent).toContainEqual(
      expect.objectContaining({ type: "error", message: "Sandbox not found" }),
    );
    expect(sandbox.commands.kill).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/sandbox after ready (#492)", () => {
  /** A sandbox that boots a static site to ready; installs wait on `finishInstall`. */
  const bootableSandbox = (sandboxId: string) => {
    const installs: Array<() => void> = [];
    let installing = 0;
    let devServer: { pid: number; envs: Record<string, string> } | null = null;
    const stats = { maxConcurrentInstalls: 0, devStarts: 0, startsWhileInstalling: 0, installsWhileServing: 0 };
    const run = vi.fn(async (cmd: string, options?: { envs?: Record<string, string> }) => {
      if (cmd === "node --version") return { exitCode: 0, stdout: "v22.12.0\n", stderr: "" };
      if (cmd.startsWith("node -e ")) return { exitCode: 0, stdout: "open", stderr: "" };
      if (options?.envs?.[DEV_COMMAND_ENV]) {
        stats.devStarts++;
        if (installing > 0) stats.startsWhileInstalling++;
        devServer = { pid: 40 + stats.devStarts, envs: options.envs };
      }
      if (devServer && cmd === killTreeCommand(devServer.pid)) devServer = null;
      if (cmd === DEFAULT_INSTALL_COMMAND) {
        if (devServer) stats.installsWhileServing++;
        installing++;
        stats.maxConcurrentInstalls = Math.max(stats.maxConcurrentInstalls, installing);
        await new Promise<void>((resolve) => installs.push(resolve));
        installing--;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const sandbox = {
      sandboxId,
      kill: vi.fn(),
      getHost: () => "4000-sbx.e2b.app",
      files: { makeDir: vi.fn(), write: vi.fn() },
      commands: {
        run,
        list: vi.fn(async () =>
          // The proxy and others run too; only the dev server carries the marker.
          [{ pid: 7, cmd: "/bin/bash", args: [], envs: {} }, ...(devServer ? [{ ...devServer, cmd: "/bin/bash", args: [], cwd: "/home/user/app" }] : [])],
        ),
      },
    };
    const finishInstall = () => installs.shift()?.();
    return { sandbox, stats, run, finishInstall, pendingInstalls: () => installs.length };
  };

  const installRuns = (run: ReturnType<typeof vi.fn>) =>
    run.mock.calls.filter(([cmd]) => cmd === DEFAULT_INSTALL_COMMAND).length;

  /** Reads NDJSON events until `type` arrives. */
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, type: string) => {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(`"type":"${type}"`)) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`stream ended before ${type}`);
      text += decoder.decode(value, { stream: true });
    }
  };

  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    while (!(await reader.read()).done) {
      // Read to the end.
    }
  };

  /** Lets pending promise callbacks and zero-delay work run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const bootToReady = async (sandboxId: string) => {
    const boot = bootableSandbox(sandboxId);
    mocks.sandboxCreate.mockResolvedValue(boot.sandbox);
    const client = new AbortController();
    const res = await POST(
      new Request("http://localhost/api/sandbox", {
        method: "POST",
        body: JSON.stringify({ files: [{ path: "index.html", content: "" }] }),
        signal: client.signal,
      }),
    );
    const reader = res.body!.getReader();
    await readUntil(reader, "ready");
    return { ...boot, client, reader };
  };

  const syncPackageJson = (sandboxId: string) =>
    PATCH(
      request(
        "PATCH",
        JSON.stringify({ files: [{ path: "package.json", content: "{}" }] }),
      ),
      { params: Promise.resolve({ sandboxId }) },
    );

  beforeEach(() => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetSandbox("sbx_ready_abort");
    forgetSandbox("sbx_ready_overlap");
    forgetSandbox("sbx_ready_burst");
  });

  it.each([
    ["vite", { scripts: { dev: "vite" } }, "npm run dev -- --host 0.0.0.0"],
    ["next", { dependencies: { next: "16" }, scripts: { dev: "next dev" } }, "npm run dev -- -H 0.0.0.0"],
    ["tanstack-start", { dependencies: { "@tanstack/react-start": "1" }, scripts: { dev: "vite dev --port 3000" } }, "npm run dev -- --host 0.0.0.0"],
  ])("boots %s with detected commands and no user settings", async (framework, pkg, command) => {
    const sandboxId = `sbx_automatic_${framework}`;
    const boot = bootableSandbox(sandboxId);
    mocks.sandboxCreate.mockResolvedValue(boot.sandbox);
    const client = new AbortController();
    const res = await POST(new Request("http://localhost/api/sandbox", {
      method: "POST",
      body: JSON.stringify({ files: [
        { path: "package.json", content: JSON.stringify(pkg) },
        { path: framework === "next" ? "next.config.ts" : "vite.config.ts", content: "" },
      ] }),
      signal: client.signal,
    }));
    const reader = res.body!.getReader();
    try {
      await vi.waitFor(() => expect(boot.pendingInstalls()).toBe(1));
      boot.finishInstall();
      await readUntil(reader, "ready");
      expect(boot.run).toHaveBeenCalledWith(DEFAULT_INSTALL_COMMAND, expect.any(Object));
      expect(boot.run).toHaveBeenCalledWith(DEV_START_COMMAND, expect.objectContaining({
        envs: expect.objectContaining({ [DEV_COMMAND_ENV]: command }),
      }));
    } finally {
      client.abort();
      await drain(reader);
      forgetSandbox(sandboxId);
    }
  });

  it("installs a burst of package.json syncs once, with the dev server stopped, and starts it once after (#486)", async () => {
    const { sandbox, stats, run, finishInstall, pendingInstalls, client, reader } =
      await bootToReady("sbx_ready_burst");
    const bootStart = run.mock.calls.find(([, options]) => options?.envs?.[DEV_COMMAND_ENV]);

    for (let i = 0; i < 3; i++) requestReinstall("sbx_ready_burst");
    await settle();
    expect(pendingInstalls()).toBe(1);
    expect(stats.installsWhileServing).toBe(0);
    // Only the marked dev server is stopped, never the proxy (pid 7).
    expect(run).toHaveBeenCalledWith(killTreeCommand(41), cleanupBounds);
    expect(run).not.toHaveBeenCalledWith(killTreeCommand(7));

    finishInstall();
    await settle();
    expect(installRuns(run)).toBe(1);
    expect(stats.devStarts).toBe(2);
    expect(stats.startsWhileInstalling).toBe(0);
    // Started again with the boot's command, env and directory.
    const restart = run.mock.calls.filter(([, options]) => options?.envs?.[DEV_COMMAND_ENV])[1];
    expect(restart[0]).toBe(bootStart![0]);
    expect(restart[1]).toMatchObject({ envs: bootStart![1]!.envs, cwd: "/home/user/app", background: true, timeoutMs: 0 });

    client.abort();
    await drain(reader);
    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("keeps the sandbox running when the client disconnects, and stops routing reinstalls to the stream", async () => {
    const { sandbox, client, reader } = await bootToReady("sbx_ready_abort");

    client.abort();
    await drain(reader);

    expect(sandbox.kill).not.toHaveBeenCalled();
    expect(requestReinstall("sbx_ready_abort")).toBe(false);
  });

  it("does not start a PATCH install while the stream's reinstall is still running", async () => {
    const { sandbox, stats, run, finishInstall, pendingInstalls, client, reader } =
      await bootToReady("sbx_ready_overlap");

    // A package.json sync queues a reinstall on the stream, then the client leaves.
    expect(requestReinstall("sbx_ready_overlap")).toBe(true);
    client.abort();
    await settle();
    expect(pendingInstalls()).toBe(1);

    // A sync during the handoff still goes through the serial queue.
    const patch = syncPackageJson("sbx_ready_overlap");
    await settle();
    expect(installRuns(run)).toBe(1);

    finishInstall();
    await settle();
    expect(installRuns(run)).toBe(2);
    let acknowledged = false;
    void patch.then(() => { acknowledged = true; });
    await settle();
    expect(acknowledged).toBe(false);
    finishInstall();
    expect((await patch).status).toBe(200);
    await drain(reader);

    expect(stats.maxConcurrentInstalls).toBe(1);
    expect(stats.installsWhileServing).toBe(0);
    expect(stats.startsWhileInstalling).toBe(0);
    // The boot's start, then one per install.
    expect(stats.devStarts).toBe(3);
    expect(sandbox.kill).not.toHaveBeenCalled();

    // Drained, so later syncs install through PATCH.
    expect(requestReinstall("sbx_ready_overlap")).toBe(false);
  });
});

describe("POST /api/sandbox replaces the project's earlier preview (#492)", () => {
  type Live = { sandboxId: string; metadata: Record<string, string> };

  /** Running sandboxes, filtered by metadata the way E2B's list query is. */
  const e2b = (live: Live[]) => {
    mocks.sandboxList.mockImplementation(
      ({ query }: { query: { metadata: Record<string, string> } }) => ({
        nextItems: async () =>
          live.filter((box) =>
            Object.entries(query.metadata).every(([key, value]) => box.metadata[key] === value),
          ),
      }),
    );
    mocks.sandboxKill.mockImplementation(async (sandboxId: string) => {
      live.splice(live.findIndex((box) => box.sandboxId === sandboxId), 1);
      return true;
    });
  };

  const boot = () =>
    POST(
      request(
        "POST",
        JSON.stringify({ files: [{ path: "index.html", content: "" }], projectId: "proj_1" }),
      ),
    );

  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.sandboxCreate.mockRejectedValue(new Error("stop after create"));
  });

  it("boots at the cap when one of the previews is this project's orphan", async () => {
    e2b([
      { sandboxId: "sbx_orphan", metadata: { userId: "user_1", projectId: "proj_1" } },
      { sandboxId: "sbx_p2", metadata: { userId: "user_1", projectId: "proj_2" } },
      { sandboxId: "sbx_p3", metadata: { userId: "user_1", projectId: "proj_3" } },
    ]);

    const res = await boot();

    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.sandboxKill).toHaveBeenCalledWith("sbx_orphan", { apiKey: "e2b-test" });
    expect(mocks.sandboxCreate).toHaveBeenCalled();
    // The fan-out policy is wired: without it, a failing fallback would fail every boot.
    const health = { primary: "e2b", cooldown: expect.objectContaining({ coolDown: expect.any(Function) }) };
    expect(killProjectPreviews).toHaveBeenCalledWith(expect.any(Array), "user_1", "proj_1", health);
    expect(atLiveSandboxCap).toHaveBeenCalledWith(expect.any(Array), "user_1", health);
  });

  it("leaves other projects' and other users' previews running", async () => {
    e2b([
      { sandboxId: "sbx_p2", metadata: { userId: "user_1", projectId: "proj_2" } },
      { sandboxId: "sbx_other_user", metadata: { userId: "user_2", projectId: "proj_1" } },
    ]);

    await (await boot()).text();

    expect(mocks.sandboxKill).not.toHaveBeenCalled();
    expect(mocks.sandboxCreate).toHaveBeenCalled();
  });

  it("does not kill the sandbox a resumed boot continues on", async () => {
    e2b([{ sandboxId: "sbx_resume_p1", metadata: { userId: "user_1", projectId: "proj_1" } }]);
    mocks.sandboxConnect.mockRejectedValue(new Error("stop after connect"));

    await (
      await POST(
        request(
          "POST",
          JSON.stringify({
            files: [{ path: "index.html", content: "" }],
            projectId: "proj_1",
            resumeSandboxId: "sbx_resume_p1",
          }),
        ),
      )
    ).text();

    expect(mocks.sandboxKill).not.toHaveBeenCalled();
  });
});

describe("POST /api/sandbox install failure (#491)", () => {
  const SECRET = "sk_live_synthetic_0123456789";

  /** A sandbox whose install prints `stderr` and exits 1, as E2B reports it. */
  const failingInstall = (stderr: string) => {
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    const run = vi.fn(async (command: string, opts?: { onStderr?: (data: string) => void }) => {
      if (command === "node --version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      opts?.onStderr?.(stderr);
      throw new (CommandExitError as unknown as new (result: object) => Error)({
        exitCode: 1,
        stderr,
        error: "exit status 1",
      });
    });
    mocks.sandboxCreate.mockResolvedValue({
      sandboxId: "sbx_1",
      commands: { run },
      files: { makeDir: vi.fn(), write: vi.fn() },
      kill: vi.fn(),
    });
  };
  const files = [{ path: "package.json", content: '{"scripts":{"dev":"vite"}}' }];

  it("reports a non-zero npm install as an install failure, not E2B's exit status", async () => {
    failingInstall("npm error code ERESOLVE\n");

    const body = await (await POST(request("POST", JSON.stringify({ files })))).text();

    expect(body).toContain("npm error code ERESOLVE");
    expect(body).toContain("failed with exit code 1");
    expect(body).not.toContain("exit status 1");
  });

  it("never sends an injected secret the install printed, in output or the error event", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.resolveProjectEnv.mockResolvedValue({
      publicEntries: [],
      secretEntries: [{ key: "API_KEY", value: SECRET }],
      failedKeys: [],
    });
    failingInstall(`postinstall: API_KEY=${SECRET}\n`);

    const body = await (
      await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))
    ).text();

    expect(body).toContain('"type":"error"');
    expect(body).toContain("[redacted]");
    expect(body).not.toContain(SECRET);
  });

  it("redacts a value split across stdout chunks with a stderr chunk in between", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.resolveProjectEnv.mockResolvedValue({ publicEntries: [], secretEntries: [{ key: "API_KEY", value: SECRET }], failedKeys: [] });
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    const run = vi.fn(async (command: string, opts?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void }) => {
      if (command === "node --version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      opts?.onStdout?.(`API_KEY=${SECRET.slice(0, 12)}`);
      opts?.onStderr?.("npm warn deprecated\n");
      opts?.onStdout?.(`${SECRET.slice(12)}\n`);
      throw new (CommandExitError as unknown as new (result: object) => Error)({ exitCode: 1, stderr: "", error: "exit status 1" });
    });
    mocks.sandboxCreate.mockResolvedValue({ sandboxId: "sbx_1", commands: { run }, files: { makeDir: vi.fn(), write: vi.fn() }, kill: vi.fn() });

    const body = await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(body).toContain("API_KEY=[redacted]");
    expect(body).not.toContain(SECRET.slice(0, 12));
    expect(body).not.toContain(SECRET.slice(12));
  });

  it("redacts a value split across dev-server stdout chunks with the route's own line in between", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.resolveProjectEnv.mockResolvedValue({ publicEntries: [], secretEntries: [{ key: "API_KEY", value: SECRET }], failedKeys: [] });
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    let devStdout: ((data: string) => void) | undefined;
    const run = vi.fn(async (command: string, opts?: { envs?: Record<string, string>; onStdout?: (data: string) => void }) => {
      if (command === "node --version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      if (opts?.envs?.[DEV_COMMAND_ENV]) {
        devStdout = opts.onStdout;
        devStdout?.(`API_KEY=${SECRET.slice(0, 12)}`);
        return { pid: 41 };
      }
      // The port probe comes after "Waiting for dev server..."; anything after it ends the boot.
      if (command.startsWith("node -e ") && devStdout) {
        devStdout(`${SECRET.slice(12)}\n`);
        devStdout = undefined;
        return { exitCode: 0, stdout: "open", stderr: "" };
      }
      if (run.mock.calls.some(([earlier]) => earlier.startsWith("node -e "))) throw new Error("stop after the dev server's output");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const write = vi.fn(async () => {
      if (run.mock.calls.some(([earlier]) => earlier.startsWith("node -e "))) throw new Error("stop after the dev server's output");
    });
    mocks.sandboxCreate.mockResolvedValue({ sandboxId: "sbx_1", commands: { run, list: vi.fn(async () => []) }, files: { makeDir: vi.fn(), write }, kill: vi.fn() });

    const body = await (await POST(request("POST", JSON.stringify({ files: [{ path: "index.html", content: "" }], projectId: "proj_1" })))).text();

    expect(body).toContain("Waiting for dev server");
    expect(body).toContain("API_KEY=[redacted]");
    expect(body).not.toContain(SECRET.slice(0, 12));
    expect(body).not.toContain(SECRET.slice(12));
  });

  it("removes a resumed sandbox's earlier .env when no variable resolves", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    mocks.resolveProjectEnv.mockResolvedValue({ publicEntries: [], secretEntries: [], failedKeys: [] });
    const run = vi.fn(async (command: string) => {
      if (command === "node --version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      if (command.startsWith("rm -f ")) throw new Error("stop after the cleanup");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_resume_rm",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      commands: { run, list: vi.fn(async () => []), kill: vi.fn() },
      files: { makeDir: vi.fn(), write: vi.fn() },
      kill: vi.fn(),
    });

    await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1", resumeSandboxId: "sbx_resume_rm" })))).text();

    expect(run.mock.calls.map(([command]) => command)).toContain("rm -f /home/user/app/.env /home/user/app/.env.local");
  });

  it("sends the failed-install line before the error event, even when a multiline secret holds it back", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 0, records: [] },
    );
    // A secret with a newline stops the redactor releasing completed lines early.
    const pem = `-----BEGIN PRIVATE KEY-----\n${"x".repeat(200)}\n-----END PRIVATE KEY-----`;
    mocks.resolveProjectEnv.mockResolvedValue({
      publicEntries: [],
      secretEntries: [{ key: "PRIVATE_KEY", value: pem }],
      failedKeys: [],
    });
    failingInstall("npm error code ERESOLVE\n");

    const body = await (
      await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))
    ).text();

    // useSandbox stops reading at the error event, so the line must come first.
    const failedLine = body.indexOf("failed with exit code 1");
    expect(failedLine).toBeGreaterThan(-1);
    expect(failedLine).toBeLessThan(body.indexOf('"type":"error"'));
  });
});

describe("PATCH /api/sandbox/[sandboxId] install failure (#497)", () => {
  const SECRET = "sk_live_synthetic_0123456789";

  it("answers with the exit code and npm code only, and keeps the sandbox", async () => {
    const run = vi.fn(async (command: string, options?: { background?: boolean }) => {
      if (options?.background) return {};
      if (command.startsWith("node -e ") || command === READ_DEV_PGID_COMMAND) return { exitCode: 0, stdout: "open", stderr: "" };
      throw new (CommandExitError as unknown as new (result: object) => Error)({
        exitCode: 1,
        stdout: `postinstall: API_KEY=${SECRET}\n`,
        stderr: `npm error code ERESOLVE\nnpm error ${SECRET}\n`,
        error: "exit status 1",
      });
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_patch",
      getHost: () => "4000-sbx.e2b.app",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      files: { write: vi.fn() },
      commands: { run, list: vi.fn(async () => []) },
    });
    const sync = () =>
      PATCH(
        request("PATCH", JSON.stringify({ files: [{ path: "package.json", content: "{}" }] })),
        { params: Promise.resolve({ sandboxId: "sbx_patch" }) },
      );

    const response = await sync();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({
      success: true,
      synced: 1,
      installFailed: { exitCode: 1, code: "ERESOLVE" },
    });

    // The handle stays cached: the next sync doesn't connect again.
    await sync();
    expect(mocks.sandboxConnect).toHaveBeenCalledTimes(1);
    forgetSandbox("sbx_patch");
  });
});

describe("PATCH reinstall timeout", () => {
  it.each([undefined, "ERESOLVE", "ETIMEDOUT", "ECONNRESET"])(
    "hands off a timeout with npm code %s without leaking output or losing its classification",
    async (code) => {
      const secret = "synthetic-private-install-output";
      const run = vi.fn(async (command: string, options: { onStderr?: (chunk: string) => void; background?: boolean }) => {
        if (options.background) return {};
        if (command.startsWith("node -e ") || command === READ_DEV_PGID_COMMAND) return { exitCode: 0, stdout: "open", stderr: "" };
        options.onStderr?.(`npm error ${secret}\nnpm error co`);
        options.onStderr?.(code ? `de ${code}\n` : "ntent\n");
        throw new TimeoutError(secret);
      });
      mocks.sandboxConnect.mockResolvedValue({
        sandboxId: "sbx_timeout",
        getHost: () => "4000-sbx.e2b.app",
        getInfo: async () => ({ metadata: { userId: "user_1" } }),
        files: { write: vi.fn() },
        commands: { run, list: vi.fn(async () => []) },
      });
      const sync = () => PATCH(
        request("PATCH", JSON.stringify({ files: [{ path: "package.json", content: "{}" }] })),
        { params: Promise.resolve({ sandboxId: "sbx_timeout" }) },
      );
      try {
        const response = await sync();
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain(secret);
        const body = JSON.parse(text);
        expect(body).toEqual({ success: true, synced: 1, installFailed: { exitCode: 124, ...(code ? { code } : {}) } });
        const failure = readInstallFailure(body, "npm install");
        if (code === "ETIMEDOUT" || code === "ECONNRESET") expect(failure?.error).toBeNull();
        else expect(failure?.error).toMatchObject({ kind: "build", file: "package.json" });
        expect(run.mock.calls.filter(([command]) => !command.startsWith("node -e ") && command !== READ_DEV_PGID_COMMAND)).toHaveLength(2);
        await sync();
        expect(mocks.sandboxConnect).toHaveBeenCalledTimes(1);
      } finally {
        forgetSandbox("sbx_timeout");
      }
    },
  );
});

describe("PATCH /api/sandbox/[sandboxId] package.json burst (#486)", () => {
  it("installs once for overlapping syncs, with the dev server stopped, and starts it once after", async () => {
    const devEnvs = { [DEV_COMMAND_ENV]: "npm run dev -- --host", API_KEY: "k" };
    let serving = true;
    const order: string[] = [];
    const run = vi.fn(async (command: string, options?: { envs?: Record<string, string> }) => {
      if (command.startsWith("node -e ")) return { exitCode: 0, stdout: "open", stderr: "" };
      if (command === killTreeCommand(9)) serving = false;
      if (options?.envs?.[DEV_COMMAND_ENV]) serving = true;
      order.push(command === DEFAULT_INSTALL_COMMAND ? `install:${serving ? "serving" : "stopped"}` : command);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_burst",
      getHost: () => "4000-sbx.e2b.app",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      files: { write: vi.fn() },
      commands: {
        run,
        list: vi.fn(async () => [
          { pid: 3, cmd: "/bin/bash", args: [], envs: {} },
          { pid: 9, cmd: "/bin/bash", args: [], envs: devEnvs, cwd: "/home/user/app" },
        ]),
      },
    });
    const sync = () =>
      PATCH(
        request("PATCH", JSON.stringify({ files: [{ path: "package.json", content: "{}" }] })),
        { params: Promise.resolve({ sandboxId: "sbx_burst" }) },
      );

    try {
      const responses = await Promise.all([sync(), sync(), sync()]);

      for (const response of responses) {
        expect(await response.json()).toEqual({ success: true, synced: 1 });
      }
      // The orphan sweep is a `node -e` script, filtered from `order` with the port probes.
      expect(order).toEqual([READ_DEV_PGID_COMMAND, killTreeCommand(9), "install:stopped", DEV_START_COMMAND]);
      expect(run).toHaveBeenCalledWith(killProjectNodesCommand("/home/user/app"), expect.anything());
      expect(run).toHaveBeenCalledWith(DEV_START_COMMAND, {
        cwd: "/home/user/app",
        envs: devEnvs,
        background: true,
        timeoutMs: 0,
        requestTimeoutMs: SHORT_CALL_MS,
      });
    } finally {
      forgetSandbox("sbx_burst");
    }
  });
});

describe("PATCH missing dev server (#774)", () => {
  it("returns a failed install, not a 503, when the restart after it fails too", async () => {
    const run = vi.fn(async (command: string, options?: { background?: boolean }) => {
      if (options?.background) throw new Error("private start output");
      if (command.startsWith("node -e ") || command === READ_DEV_PGID_COMMAND) return { exitCode: 0, stdout: "", stderr: "" };
      throw new (CommandExitError as unknown as new (result: object) => Error)({
        exitCode: 1, stdout: "", stderr: "npm error code ERESOLVE\n", error: "exit status 1",
      });
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_install_and_start_fail",
      getHost: () => "4000-sbx.e2b.app",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      files: { write: vi.fn() },
      commands: { run, list: vi.fn(async () => []) },
    });
    try {
      const response = await PATCH(request("PATCH", JSON.stringify({ files: [{ path: "package.json", content: "{}" }] })),
        { params: Promise.resolve({ sandboxId: "sbx_install_and_start_fail" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, synced: 1, installFailed: { exitCode: 1, code: "ERESOLVE" } });
    } finally {
      forgetSandbox("sbx_install_and_start_fail");
    }
  });

  it.each([false, true])("starts a missing server after install and surfaces start failure (%s)", async (startFails) => {
    const run = vi.fn(async (command: string, options?: { background?: boolean }) => {
      if (options?.background && startFails) throw new Error("private start output");
      if (command.startsWith("node -e ")) return { exitCode: 0, stdout: "open", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_missing_dev",
      getHost: () => "4000-sbx.e2b.app",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      files: { write: vi.fn() },
      commands: { run, list: vi.fn(async () => []) },
    });
    try {
      const response = await PATCH(request("PATCH", JSON.stringify({
        files: [{ path: "package.json", content: "{}" }], devCommand: "vite --port 5173",
      })), { params: Promise.resolve({ sandboxId: "sbx_missing_dev" }) });
      const commands = run.mock.calls.map(([command]) => command);
      // The group record read and orphan sweep run first; the server starts in its own group.
      expect(commands.slice(0, 4)).toEqual([READ_DEV_PGID_COMMAND, killProjectNodesCommand("/home/user/app"), DEFAULT_INSTALL_COMMAND, DEV_START_COMMAND]);
      expect(run.mock.calls[3][1]).toMatchObject({ envs: { [DEV_COMMAND_ENV]: "vite --port 5173 --host 0.0.0.0" } });
      expect(response.status).toBe(startFails ? 503 : 200);
      const body = await response.json();
      if (startFails) {
        expect(body.code).toBe("dev_server_unavailable");
        expect(body.error).not.toContain("private start output");
      } else {
        expect(body).toEqual({ success: true, synced: 1 });
        // Ready once Vite's port listens.
        expect(commands[4]).toContain("port:5173");
      }
    } finally {
      forgetSandbox("sbx_missing_dev");
    }
  });
});

describe("POST /api/sandbox runtime admission fence", () => {
  const SECRET = "sk_live_synthetic_fence_0123456789";
  const files = [{ path: "package.json", content: '{"scripts":{"dev":"vite"}}' }];

  /** A new sandbox whose install is the last step; `order` logs the fence and the .env write. */
  const fencedBoot = (order: string[]) => {
    const run = vi.fn(async (command: string) => {
      if (command === "node --version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      order.push("install");
      throw new Error("stop at install");
    });
    const write = vi.fn(async (entries: Array<{ path: string }> | string) => {
      const paths = Array.isArray(entries) ? entries.map((entry) => entry.path) : [entries];
      if (paths.some((path) => path.endsWith("/.env"))) order.push("write .env");
    });
    const sandbox = { sandboxId: "sbx_fence", commands: { run, list: vi.fn(async () => []) }, files: { makeDir: vi.fn(), write }, kill: vi.fn() };
    mocks.sandboxCreate.mockResolvedValue(sandbox);
    return sandbox;
  };

  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : "sandboxId" in args ? [] : { generation: 3, records: [] },
    );
    mocks.resolveProjectEnv.mockResolvedValue({ publicEntries: [], secretEntries: [{ key: "API_KEY", value: SECRET }], failedKeys: [] });
  });

  it("registers and admits the boot at the manifest's generation before writing any variable", async () => {
    const order: string[] = [];
    fencedBoot(order);
    mocks.mutation.mockImplementation(async (_ref, args: Record<string, unknown>) => {
      order.push("handleId" in args ? "admit" : "register");
      return "handleId" in args ? "admitted" : "handle_1";
    });

    await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(order).toEqual(["register", "admit", "write .env", "install"]);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), {
      internalKey: "internal", projectId: "proj_1", ownerId: "user_1",
      sandboxId: "e2b:sbx_fence", generation: 3, replacesPreviews: true,
    });
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), { internalKey: "internal", handleId: "handle_1" });
  });

  it("aborts and kills the sandbox without injecting anything when admission is refused", async () => {
    const order: string[] = [];
    const sandbox = fencedBoot(order);
    mocks.mutation.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "handleId" in args ? "outdated" : "handle_1",
    );

    const body = await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(body).toContain("environment variables changed while the preview was starting");
    expect(body).toContain('"type":"error"');
    expect(order).toEqual([]);
    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("lets no sync reinstall run with the values before admission, nor at all once it is refused", async () => {
    const order: string[] = [];
    const sandbox = fencedBoot(order);
    const reinstallBeforeAdmit: boolean[] = [];
    mocks.mutation.mockImplementation(async (_ref, args: Record<string, unknown>) => {
      if (!("handleId" in args)) return "handle_1";
      reinstallBeforeAdmit.push(requestReinstall("sbx_fence"));
      return "outdated";
    });

    await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(reinstallBeforeAdmit).toEqual([false]);
    expect(requestReinstall("sbx_fence")).toBe(false);
    expect(sandbox.commands.run).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ envs: expect.objectContaining({ API_KEY: SECRET }) }));
    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("says a newer preview replaced this boot", async () => {
    fencedBoot([]);
    mocks.mutation.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "handleId" in args ? "replaced" : "handle_1",
    );

    const body = await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(body).toContain("A newer preview of this project started");
  });

  it("aborts and kills the sandbox when registration fails", async () => {
    const order: string[] = [];
    const sandbox = fencedBoot(order);
    mocks.mutation.mockRejectedValue(new Error("Project not found"));

    const body = await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(body).toContain('"type":"error"');
    expect(order).toEqual([]);
    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("boots a project without secret values exactly as before, without the fence", async () => {
    const order: string[] = [];
    fencedBoot(order);
    mocks.resolveProjectEnv.mockResolvedValue({ publicEntries: [{ key: "VITE_URL", value: "https://example.com" }], secretEntries: [], failedKeys: [] });

    await (await POST(request("POST", JSON.stringify({ files, projectId: "proj_1" })))).text();

    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(order).toEqual(["write .env", "install"]);
  });
});

describe("POST /api/sandbox revoked runtimes", () => {
  beforeEach(() => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.sandboxList.mockReturnValue({ nextItems: async () => [] });
  });

  it("kills the project's revoked previews and refuses to resume one", async () => {
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args
        ? { _id: "proj_1", ownerId: "user_1" }
        : "sandboxId" in args
          ? [{ _id: "handle_old", sandboxId: "e2b:sbx_stale" }]
          : { generation: 1, records: [] },
    );
    mocks.sandboxKill.mockResolvedValue(true);

    const res = await POST(request("POST", JSON.stringify({
      files: [{ path: "index.html", content: "" }], projectId: "proj_1", resumeSandboxId: "sbx_stale",
    })));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("environment variables changed") });
    expect(mocks.sandboxKill).toHaveBeenCalledWith("sbx_stale", expect.anything());
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), { internalKey: "internal", handleId: "handle_old", killed: true });
    expect(mocks.sandboxConnect).not.toHaveBeenCalled();
  });

  it("refuses to sync into a revoked preview, which a restarted dev server would load the old values into", async () => {
    mocks.query.mockImplementation(async () => [{ _id: "handle_old", sandboxId: "e2b:sbx_patch_stale" }]);
    mocks.sandboxKill.mockResolvedValue(false);
    const write = vi.fn();
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_patch_stale",
      getInfo: async () => ({ metadata: { userId: "user_1" } }),
      files: { write },
      commands: { run: vi.fn(), list: vi.fn(async () => []) },
    });

    const res = await PATCH(
      request("PATCH", JSON.stringify({ files: [{ path: "package.json", content: "{}" }] })),
      { params: Promise.resolve({ sandboxId: "sbx_patch_stale" }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "env_changed" });
    expect(write).not.toHaveBeenCalled();
    // Already gone counts as killed.
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), { internalKey: "internal", handleId: "handle_old", killed: true });
  });
});
