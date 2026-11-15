import {
  AuthenticationError,
  CommandExitError,
  RateLimitError,
  Sandbox as E2bSandbox,
  TimeoutError,
} from "e2b";

import {
  type CreateOptions,
  type RequestOptions,
  type Sandbox,
  SandboxConfigError,
  type SandboxProvider,
  SandboxRateLimitError,
  SandboxTimeoutError,
} from "./types";

/** Translates E2B's errors into the seam's; anything else is rethrown as is. */
export const fromE2bError = (error: unknown): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthenticationError) return new SandboxConfigError(message, { cause: error });
  if (error instanceof RateLimitError) return new SandboxRateLimitError(message, { cause: error });
  if (error instanceof TimeoutError) return new SandboxTimeoutError(message, { cause: error });
  return error;
};

const call = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw fromE2bError(error);
  }
};

const handles = new WeakMap<Sandbox, E2bSandbox>();

/**
 * The raw E2B handle behind a seam sandbox, or null for another provider.
 * shortcut: only for `dev-server.ts` (typed to the E2B handle until PR1b moves it)
 * and the swarm's envd-version gate; delete once nothing needs it.
 */
export const e2bHandleOf = (sandbox: Sandbox) => handles.get(sandbox) ?? null;

/** The seam's view of an E2B sandbox. */
export const fromE2bSandbox = (sandbox: E2bSandbox): Sandbox => {
  const wrapped = wrap(sandbox);
  handles.set(wrapped, sandbox);
  return wrapped;
};

const wrap = (sandbox: E2bSandbox): Sandbox => ({
  provider: "e2b",
  id: sandbox.sandboxId,
  run: (command, opts) =>
    // No options means E2B's defaults, as a direct `commands.run(command)` gets.
    call(() => (opts ? sandbox.commands.run(command, opts) : sandbox.commands.run(command))).catch((error: unknown) => {
      // E2B throws on a non-zero exit; the seam reports it as a result.
      if (error instanceof CommandExitError) {
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
      throw error;
    }),
  start: async (command, opts) => {
    // timeoutMs 0: E2B would otherwise kill the command after its default 60s.
    const handle = await call(() => sandbox.commands.run(command, { ...opts, background: true as const, timeoutMs: 0 }));
    return { pid: handle.pid };
  },
  writeFiles: async (files, opts) => {
    // E2B creates the parent directories of a batch write.
    if (files.length) await call(() => (opts ? sandbox.files.write(files, opts) : sandbox.files.write(files)));
  },
  readFile: ((path: string, format: "text" | "bytes", opts?: RequestOptions) =>
    call<string | Uint8Array>(() =>
      format === "bytes"
        ? sandbox.files.read(path, { ...opts, format: "bytes" })
        : sandbox.files.read(path, { ...opts, format: "text" }),
    )) as Sandbox["readFile"],
  previewUrl: async (port) => `https://${sandbox.getHost(port)}`,
  info: async (opts) => {
    const { metadata, endAt } = await call(() => sandbox.getInfo(opts));
    return { metadata, endAt };
  },
  kill: async (opts) => {
    await call(() => sandbox.kill(opts));
  },
  // envd's own list: each command's root process, with the envs it was started with.
  listCommands: (opts) => call(() => (opts ? sandbox.commands.list(opts) : sandbox.commands.list())),
  killCommand: (pid, opts) => call(() => sandbox.commands.kill(pid, opts)),
});

/** Sandbox lifetime cap on the E2B plan we run on. */
const E2B_MAX_SESSION_MS = 60 * 60 * 1000;

/**
 * The Node 22 template `npm run e2b:template` builds, used when E2B_TEMPLATE is unset.
 * Never `base`: it ships Node 20.9, too old for Vite 7 (#178).
 */
export const DEFAULT_E2B_TEMPLATE = "codenaya-node22";

/** The E2B adapter. `apiKey` is read by the registry per request. */
export const createE2bProvider = (apiKey: string): SandboxProvider => {
  const create = (from: string, { timeoutMs, metadata, requestTimeoutMs, localHostHeader }: Omit<CreateOptions, "image">) =>
    call(() =>
      E2bSandbox.create(from, {
        apiKey,
        timeoutMs,
        metadata,
        requestTimeoutMs,
        ...(localHostHeader && { network: { maskRequestHost: "localhost:${PORT}" } }),
      }),
    ).then(fromE2bSandbox);

  return {
    id: "e2b",
    maxSessionMs: E2B_MAX_SESSION_MS,
    // Read per call, like project-sandbox's SANDBOX_TEMPLATE (which also warns once when it is unset).
    create: ({ image, ...opts }) => create(image ?? (process.env.E2B_TEMPLATE?.trim() || DEFAULT_E2B_TEMPLATE), opts),
    connect: (id, opts) => call(() => E2bSandbox.connect(id, { ...opts, apiKey })).then(fromE2bSandbox),
    list: async ({ metadata, limit, requestTimeoutMs }) => {
      const running = await call(() =>
        E2bSandbox.list({ apiKey, requestTimeoutMs, limit, query: { metadata, state: ["running"] } }).nextItems(),
      );
      return running.map(({ sandboxId, metadata, endAt }) => ({ id: sandboxId, metadata, endAt }));
    },
    kill: (id, opts) => call(() => E2bSandbox.kill(id, { ...opts, apiKey })),
    snapshot: async (sandbox, opts) =>
      (await call(() => E2bSandbox.createSnapshot(sandbox.id, { ...opts, apiKey }))).snapshotId,
    createFromSnapshot: (snapshotId, opts) => create(snapshotId, opts),
    deleteSnapshot: (snapshotId, opts) => call(() => E2bSandbox.deleteSnapshot(snapshotId, { ...opts, apiKey })),
  };
};
