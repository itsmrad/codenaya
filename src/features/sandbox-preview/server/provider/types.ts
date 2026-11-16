/**
 * The vendor-neutral sandbox seam (ADR 0015). Callers depend on these types;
 * only `e2b.ts` (and future adapters) import a vendor SDK.
 */

/** Every provider with an adapter. A public sandbox id must name one of these. */
export const PROVIDER_IDS = ["e2b"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Tags set at create and filtered on by `list` ({ userId, projectId, messageId, ... }).
 * Ownership is checked against `userId`, so every adapter must store it.
 */
export type SandboxMeta = Record<string, string>;

/** Bounds every adapter call by the caller's remaining budget. */
export interface RequestOptions {
  requestTimeoutMs?: number;
}

export interface RunOptions extends RequestOptions {
  cwd?: string;
  envs?: Record<string, string>;
  /** How long the command may run; 0 means no limit. */
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxInfo {
  metadata: SandboxMeta;
  /** When the provider kills the sandbox; the warm-preview lookup needs time left. */
  endAt: Date;
  /** False when this sandbox's image cannot be snapshotted (E2B: envd older than 0.5.0); unknown when absent. */
  canSnapshot?: boolean;
}

export interface ListedSandbox extends SandboxInfo {
  id: string;
}

/** A command started with `run` or `start` that is still running. */
export interface SandboxCommand {
  pid: number;
  cmd: string;
  args: string[];
  /** The envs it was started with, not its whole environment. */
  envs: Record<string, string>;
  cwd?: string;
}

export interface Sandbox {
  readonly provider: ProviderId;
  /** The provider's own id; the public id is `toPublicSandboxId(provider, id)`. */
  readonly id: string;
  /** Resolves with the exit code instead of throwing on a non-zero exit. */
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /**
   * Starts `command` in the background with no time limit (dev server, proxy) and
   * resolves once it started. Output streams until it exits or the sandbox dies.
   */
  start(command: string, opts?: Omit<RunOptions, "timeoutMs">): Promise<{ pid: number }>;
  /** Writes every file in one batch where the provider can; parent directories are created. */
  writeFiles(files: { path: string; data: string | ArrayBuffer }[], opts?: RequestOptions): Promise<void>;
  readFile(path: string, format: "text", opts?: RequestOptions): Promise<string>;
  readFile(path: string, format: "bytes", opts?: RequestOptions): Promise<Uint8Array>;
  /** Public https URL of `port` that the preview iframe can load, WebSocket upgrades included. */
  previewUrl(port: number): Promise<string>;
  info(opts?: RequestOptions): Promise<SandboxInfo>;
  kill(opts?: RequestOptions): Promise<void>;
  /** The provider's own command list; without one, `listCommands` in helpers.ts reads /proc. */
  listCommands?(opts?: RequestOptions): Promise<SandboxCommand[]>;
  /** Signals one listed command's root process, without its children; for when `run` fails. */
  killCommand?(pid: number, opts?: RequestOptions): Promise<boolean>;
}

export interface CreateOptions extends RequestOptions {
  /** The provider's template/image/snapshot name; the adapter's configured default when absent. */
  image?: string;
  /** Sandbox lifetime. */
  timeoutMs: number;
  metadata: SandboxMeta;
  /** Requests forwarded to a port carry `Host: localhost:<port>`, as the dev servers expect. */
  localHostHeader?: boolean;
}

export interface SandboxProvider {
  readonly id: ProviderId;
  /** Longest sandbox lifetime the account allows. */
  readonly maxSessionMs: number;
  create(opts: CreateOptions): Promise<Sandbox>;
  /** `timeoutMs` extends the sandbox's lifetime from now. */
  connect(id: string, opts?: RequestOptions & { timeoutMs?: number }): Promise<Sandbox>;
  /** Observe an already-running sandbox without resuming it or changing its expiration. */
  inspect?(id: string, opts?: RequestOptions): Promise<Sandbox>;
  /** Running sandboxes whose metadata matches every given tag; one page of up to `limit`. */
  list(query: { metadata?: SandboxMeta; limit?: number } & RequestOptions): Promise<ListedSandbox[]>;
  /** False when the sandbox was already gone. */
  kill(id: string, opts?: RequestOptions): Promise<boolean>;
  // Swarm worker sandboxes only. A provider without them leaves all three out.
  snapshot?(sandbox: Sandbox, opts?: RequestOptions): Promise<string>;
  createFromSnapshot?(snapshotId: string, opts: Omit<CreateOptions, "image">): Promise<Sandbox>;
  deleteSnapshot?(snapshotId: string, opts?: RequestOptions): Promise<boolean>;
}

/** Missing or rejected credentials; routes report it as the `config` failure. */
export class SandboxConfigError extends Error {
  name = "SandboxConfigError";
}

/** The provider has no such sandbox: it expired, was killed or never existed. */
export class SandboxNotFoundError extends Error {
  name = "SandboxNotFoundError";
}

/** The provider throttled us or the account is out of quota; routes report `rate_limit`. */
export class SandboxRateLimitError extends Error {
  name = "SandboxRateLimitError";
}

/** `runOrThrow`'s non-zero exit, with E2B's "exit status N" message and the result. */
export class SandboxExitError extends Error {
  name = "SandboxExitError";
  constructor(readonly result: RunResult) {
    super(`exit status ${result.exitCode}`);
  }
}

/** A command, a request or the sandbox itself ran out of time. */
export class SandboxTimeoutError extends Error {
  name = "SandboxTimeoutError";
}
