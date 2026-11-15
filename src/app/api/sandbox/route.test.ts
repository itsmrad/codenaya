/**
 * The sandbox routes answer 400 for a malformed or invalid body, before they
 * touch Convex or E2B (#235).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  query: vi.fn(),
  sandboxCreate: vi.fn(),
  sandboxConnect: vi.fn(),
  sandboxList: vi.fn(),
  sandboxKill: vi.fn(),
  resolveProjectEnv: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/convex-client", () => ({ convex: { query: mocks.query } }));
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
} from "@/features/sandbox-preview/server/project-sandbox";
import {
  DEV_COMMAND_ENV,
  killTreeCommand,
} from "@/features/sandbox-preview/server/dev-server";
import {
  forgetSandbox,
  requestReinstall,
} from "@/features/sandbox-preview/server/sandbox-registry";
import { PATCH } from "./[sandboxId]/route";

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
  resetRateLimits();
  vi.stubEnv("E2B_API_KEY", "e2b-test");
  mocks.auth.mockResolvedValue({ userId: "user_1" });
});

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
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [],
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

    expect(mocks.sandboxConnect).toHaveBeenCalledWith("sbx_resume");
    expect(sandbox.commands.run.mock.calls).toEqual([
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
      [killTreeCommand(7), { timeoutMs: 10_000 }],
      [killTreeCommand(8), { timeoutMs: 10_000 }],
      [killTreeCommand(9), { timeoutMs: 10_000 }],
      ["node --version", { timeoutMs: 10_000 }],
    ]);
    expect(sandbox.commands.kill).not.toHaveBeenCalled();
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
      if (cmd.startsWith("curl")) return { exitCode: 0, stdout: "200", stderr: "" };
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

  it("installs a burst of package.json syncs once, with the dev server stopped, and starts it once after (#486)", async () => {
    const { sandbox, stats, run, finishInstall, pendingInstalls, client, reader } =
      await bootToReady("sbx_ready_burst");
    const bootStart = run.mock.calls.find(([, options]) => options?.envs?.[DEV_COMMAND_ENV]);

    for (let i = 0; i < 3; i++) requestReinstall("sbx_ready_burst");
    await settle();
    expect(pendingInstalls()).toBe(1);
    expect(stats.installsWhileServing).toBe(0);
    // Only the marked dev server is stopped, never the proxy (pid 7).
    expect(run).toHaveBeenCalledWith(killTreeCommand(41));
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
    expect((await patch).status).toBe(200);
    finishInstall();
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
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [],
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
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [],
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

  it("sends the failed-install line before the error event, even when a multiline secret holds it back", async () => {
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "internal");
    mocks.query.mockImplementation(async (_ref, args: Record<string, unknown>) =>
      "userId" in args ? { _id: "proj_1", ownerId: "user_1" } : [],
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
    const run = vi.fn(async () => {
      throw new (CommandExitError as unknown as new (result: object) => Error)({
        exitCode: 1,
        stdout: `postinstall: API_KEY=${SECRET}\n`,
        stderr: `npm error code ERESOLVE\nnpm error ${SECRET}\n`,
        error: "exit status 1",
      });
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_patch",
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
      const run = vi.fn(async (_command: string, options: { onStderr?: (chunk: string) => void }) => {
        options.onStderr?.(`npm error ${secret}\nnpm error co`);
        options.onStderr?.(code ? `de ${code}\n` : "ntent\n");
        throw new TimeoutError(secret);
      });
      mocks.sandboxConnect.mockResolvedValue({
        sandboxId: "sbx_timeout",
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
        expect(run).toHaveBeenCalledTimes(1);
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
      if (command === killTreeCommand(9)) serving = false;
      if (options?.envs?.[DEV_COMMAND_ENV]) serving = true;
      order.push(command === DEFAULT_INSTALL_COMMAND ? `install:${serving ? "serving" : "stopped"}` : command);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mocks.sandboxConnect.mockResolvedValue({
      sandboxId: "sbx_burst",
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
      expect(order).toEqual([killTreeCommand(9), "install:stopped", "npm run dev -- --host"]);
      expect(run).toHaveBeenLastCalledWith("npm run dev -- --host", {
        cwd: "/home/user/app",
        envs: devEnvs,
        background: true,
        timeoutMs: 0,
      });
    } finally {
      forgetSandbox("sbx_burst");
    }
  });
});
