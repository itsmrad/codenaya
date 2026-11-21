import { randomUUID } from "node:crypto";

import {
  CredentialsError,
  MAX_CREATION_TIMEOUT_SECONDS,
  SandboxCreationTimeoutError,
  SandboxInstance,
  getBlaxelErrorCode,
  getBlaxelErrorMessage,
  getBlaxelErrorStatus,
  isGatewayTimeout,
} from "@blaxel/core";

import { PREVIEW_PROXY_PORT } from "../dev-server";
import {
  type ListedSandbox,
  type ProviderId,
  type RequestOptions,
  type Sandbox,
  SandboxConfigError,
  type SandboxInfo,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxRateLimitError,
  SandboxTimeoutError,
} from "./types";

// Not in PROVIDER_IDS until the adapter is registered; this is its one cast until then.
const BLAXEL_ID = "blaxel" as string as ProviderId;

/** The Node 22 image, used when BLAXEL_IMAGE is unset. */
export const DEFAULT_BLAXEL_IMAGE = "codenaya-node22";
export const DEFAULT_BLAXEL_REGION = "us-was-1";
/** 4096 MB also gets 2 CPUs (memory / 2048). */
const MEMORY_MB = 4096;
const BLAXEL_MAX_SESSION_MS = 60 * 60 * 1000;
/** The SDK has no HTTP timeout at all; E2B's default is 30 s. Long waits pass their own. */
const BLAXEL_REQUEST_TIMEOUT_MS = 30_000;
const LIST_PAGE_SIZE = 200;
/** Past this many pages `list` throws rather than undercount the per-user cap. */
const MAX_LIST_PAGES = 5;

const CONFIG_CODE = /^(AUTHENTICATION_|UNAUTHORIZED|TOKEN_REVOKED$|WORKSPACE_REQUIRED$)/;
const RATE_LIMIT_CODES = new Set(["USAGE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "RATE_LIMIT_EXCEEDED", "WORKSPACE_RATE_LIMIT_EXCEEDED"]);
const GONE_CODES = new Set(["WORKLOAD_NOT_FOUND", "SANDBOX_DELETED", "SANDBOX_DELETION_IN_PROGRESS"]);

/**
 * Where a call failed decides what a 400/404 means: on an existing sandbox (`sandbox`)
 * a 404 is a gone sandbox, on `create` a 400/404 is our image, region or labels, and
 * anywhere else (a missing file) it is rethrown as is.
 */
type Scope = "sandbox" | "create";

/**
 * Translates Blaxel's errors into the seam's. The control plane can reject with a raw
 * body rather than an Error, so that becomes an Error with it as cause.
 */
export const fromBlaxelError = (error: unknown, scope?: Scope): unknown => {
  const status = getBlaxelErrorStatus(error);
  const code = String(getBlaxelErrorCode(error) ?? "");
  const message = getBlaxelErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
  const options = { cause: error };
  if (error instanceof CredentialsError || status === 401 || status === 403 || CONFIG_CODE.test(code)) {
    return new SandboxConfigError(message, options);
  }
  if (status === 402 || status === 429 || RATE_LIMIT_CODES.has(code)) return new SandboxRateLimitError(message, options);
  if (error instanceof SandboxCreationTimeoutError || isGatewayTimeout(error)) return new SandboxTimeoutError(message, options);
  // A bad image, region or label: fail over rather than report the sandbox gone.
  if (scope === "create" && (status === 400 || status === 404)) return new SandboxConfigError(message, options);
  if (scope === "sandbox" && (status === 404 || GONE_CODES.has(code))) return new SandboxNotFoundError(message, options);
  return error instanceof Error ? error : new Error(message, options);
};

/** Our own `requestTimeoutMs` ran out; the SDK has no per-call timeout. */
class DeadlineError extends SandboxTimeoutError {}

const withDeadline = <T>(request: Promise<T>, ms?: number): Promise<T> => {
  if (!ms) return request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`Blaxel request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
};

/** Without `requestTimeoutMs` a request gets 30 s; 0 means no deadline. */
const call = async <T>(request: () => Promise<T>, ms = BLAXEL_REQUEST_TIMEOUT_MS, scope?: Scope): Promise<T> => {
  try {
    return await withDeadline(request(), ms);
  } catch (error) {
    throw fromBlaxelError(error, scope);
  }
};

/** Lowercase alphanumeric with a prefix, within Blaxel's 49 characters and ids.ts's native id. */
export const newSandboxName = () => `cn-${randomUUID().replaceAll("-", "").slice(0, 20)}`;

/** Deletes the sandbox at `endAt`, running or on standby, as E2B's timeout kills it. */
const lifecycle = (endAt: number) => ({
  expirationPolicies: [{ type: "date" as const, value: new Date(endAt).toISOString(), action: "delete" as const }],
});

const endAtOf = (sandbox: SandboxInstance) => {
  const date = sandbox.spec.lifecycle?.expirationPolicies?.find(({ type }) => type === "date")?.value;
  return date ? new Date(date) : new Date(Date.now() + (sandbox.expiresIn ?? 0) * 1000);
};

const infoOf = (sandbox: SandboxInstance): SandboxInfo => ({ metadata: { ...sandbox.metadata.labels }, endAt: endAtOf(sandbox) });

/** A standby sandbox still reports DEPLOYED and resumes on its next request. */
const isRunning = (sandbox: SandboxInstance) =>
  (sandbox.status === "DEPLOYING" || sandbox.status === "DEPLOYED") && endAtOf(sandbox).getTime() > Date.now();

const getRunning = async (name: string, ms?: number) => {
  const sandbox = await call(() => SandboxInstance.get(name), ms, "sandbox");
  if (!isRunning(sandbox)) throw new SandboxNotFoundError("Sandbox is not running");
  return sandbox;
};

/**
 * False once the sandbox is gone (404). While it is still DELETING, a few seconds, another
 * delete succeeds and reports DELETING just as the first did, so a second kill in that
 * window is true too. Telling them apart would take a read before every delete, and no
 * caller reads the answer.
 */
const kill = async (name: string, { requestTimeoutMs }: RequestOptions = {}) => {
  try {
    await call(() => SandboxInstance.delete(name), requestTimeoutMs, "sandbox");
    return true;
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return false;
    throw error;
  }
};

/** E2B's default command timeout, so a `run` without `timeoutMs` behaves the same on both. */
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/** `streamLogs` (start's path) hands output over one line at a time with its newline stripped; E2B's chunks keep theirs. */
const lines = (onData?: (data: string) => void) => onData && ((line: string) => onData(`${line}\n`));

/** The seam's view of a Blaxel sandbox. */
const wrap = (sandbox: SandboxInstance): Sandbox => {
  const name = sandbox.metadata.name;
  const previews = new Map<number, Promise<string>>();
  return {
    provider: BLAXEL_ID,
    id: name,
    run: async (command, { cwd, envs, timeoutMs = DEFAULT_RUN_TIMEOUT_MS, onStdout, onStderr, requestTimeoutMs } = {}) => {
      // The output comes from the streamed chunks, not the result, which keeps only its last ~64 KB.
      let stdout = "";
      let stderr = "";
      const startedAt = Date.now();
      const result = await call(
        () =>
          sandbox.process.exec({
            command,
            workingDir: cwd,
            env: envs,
            waitForCompletion: true,
            timeout: Math.ceil(timeoutMs / 1000),
            // Always stream: a held, silent request is cut by Blaxel's edge after
            // 120s, while a streamed one gets keepalives. Its chunks are raw output,
            // newlines kept and split anywhere, as E2B's are: pass them on unchanged.
            onStdout: (chunk) => {
              stdout += chunk;
              onStdout?.(chunk);
            },
            onStderr: (chunk) => {
              stderr += chunk;
              onStderr?.(chunk);
            },
          }),
        // The request outlives the command: its own budget, else the command's limit plus 30 s.
        requestTimeoutMs ?? (timeoutMs && timeoutMs + BLAXEL_REQUEST_TIMEOUT_MS),
      );
      // A non-zero exit is a result. `killed` is a timeout only once the command's own limit
      // has passed; anything else that killed it (killTree) leaves a result.
      if (timeoutMs && result.status === "killed" && Date.now() - startedAt >= timeoutMs) {
        throw new SandboxTimeoutError(`Command timed out after ${timeoutMs}ms`);
      }
      // Nothing streamed (the server answered without streaming): the result is all there is.
      return { exitCode: result.exitCode, stdout: stdout || result.stdout, stderr: stderr || result.stderr };
    },
    start: async (command, { cwd, envs, onStdout, onStderr, requestTimeoutMs } = {}) => {
      // No timeout means none (Blaxel's default 0). Never keepAlive: it blocks standby, which costs.
      // With callbacks the SDK follows the output until the process exits.
      const started = await call(
        () => sandbox.process.exec({ command, workingDir: cwd, env: envs, waitForCompletion: false, onStdout: lines(onStdout), onStderr: lines(onStderr) }),
        requestTimeoutMs,
      );
      return { pid: Number(started.pid) };
    },
    writeFiles: async (files, { requestTimeoutMs } = {}) => {
      // Parents are created. Text goes in one request; writeBinary takes a string as a local path, so bytes go one by one.
      const text = files.flatMap(({ path, data }) => (typeof data === "string" ? [{ path: path.replace(/^\/+/, ""), content: data }] : []));
      const bytes = files.filter((file): file is { path: string; data: ArrayBuffer } => typeof file.data !== "string");
      await Promise.all([
        ...(text.length ? [call(() => sandbox.fs.writeTree(text, "/"), requestTimeoutMs)] : []),
        ...bytes.map(({ path, data }) => call(() => sandbox.fs.writeBinary(path, new Uint8Array(data)), requestTimeoutMs)),
      ]);
    },
    readFile: ((path: string, format: "text" | "bytes", { requestTimeoutMs }: RequestOptions = {}) =>
      call<string | Uint8Array>(
        async () => (format === "bytes" ? new Uint8Array(await (await sandbox.fs.readBinary(path)).arrayBuffer()) : sandbox.fs.read(path)),
        requestTimeoutMs,
      )) as Sandbox["readFile"],
    // Public, as E2B's URLs are: the iframe can't send a token header. The URL's hash keeps it unguessable.
    previewUrl: (port) => {
      let url = previews.get(port);
      if (!url) {
        url = call(() => sandbox.previews.createIfNotExists({ port, name: `p${port}`, public: true })).then((preview) => preview.url);
        url.catch(() => previews.delete(port));
        previews.set(port, url);
      }
      return url;
    },
    // Read fresh: the owner check and the warm-preview lookup need current labels and endAt.
    info: async ({ requestTimeoutMs } = {}) => infoOf(await call(() => SandboxInstance.get(name), requestTimeoutMs, "sandbox")),
    kill: async (opts) => {
      await kill(name, opts);
    },
  };
};

/**
 * The Blaxel adapter; nothing registers it yet. The SDK reads BL_WORKSPACE and BL_API_KEY
 * itself, and at import time also reads ./.env and ./blaxel.toml from the cwd, whose values
 * win over process.env (and ~/.blaxel/config.yaml).
 */
export const createBlaxelProvider = (): SandboxProvider => ({
  id: BLAXEL_ID,
  maxSessionMs: BLAXEL_MAX_SESSION_MS,
  // localHostHeader is ignored: our :4000 proxy rewrites Host itself.
  create: async ({ image, timeoutMs, metadata, requestTimeoutMs = BLAXEL_REQUEST_TIMEOUT_MS }) => {
    const name = newSandboxName();
    let pending: Promise<SandboxInstance> | undefined;
    const sandbox = await call(
      () =>
        (pending = SandboxInstance.create(
          {
            name,
            // Read per call, like E2B_TEMPLATE.
            image: image ?? (process.env.BLAXEL_IMAGE?.trim() || DEFAULT_BLAXEL_IMAGE),
            memory: MEMORY_MB,
            region: process.env.BL_REGION?.trim() || DEFAULT_BLAXEL_REGION,
            ports: [{ name: "preview", target: PREVIEW_PROXY_PORT }],
            labels: metadata,
            lifecycle: lifecycle(Date.now() + timeoutMs),
          },
          { timeout: requestTimeoutMs ? Math.min(MAX_CREATION_TIMEOUT_SECONDS, Math.ceil(requestTimeoutMs / 1000)) : undefined },
        )),
      requestTimeoutMs,
      "create",
    ).catch((error: unknown) => {
      // Our deadline left the create running: delete what it makes. (Blaxel's own
      // creation timeout already released the sandbox.) The date policy bounds it anyway.
      if (error instanceof DeadlineError) void pending?.then(() => SandboxInstance.delete(name)).catch(() => {});
      throw error;
    });
    // Ownership lives in the labels, so never hand out a sandbox that lost one.
    // TODO(B5): validate label values against Blaxel's charset once the live smoke shows it.
    const labels = sandbox.metadata.labels ?? {};
    if (Object.entries(metadata).some(([key, value]) => labels[key] !== value)) {
      void SandboxInstance.delete(name).catch(() => {});
      throw new SandboxConfigError("Blaxel did not keep the sandbox's labels");
    }
    return wrap(sandbox);
  },
  connect: async (id, { requestTimeoutMs, timeoutMs } = {}) => {
    let sandbox = await getRunning(id, requestTimeoutMs);
    // Extend only, never shorten, and never past createdAt + 1 h: unlike E2B, Blaxel
    // has no hard cap, and the share heartbeat extends on every beat. No createdAt, no extension.
    // Blaxel's update reads then writes, so two concurrent connects can race; the later write wins.
    // There is no lifecycle-only endpoint: updateLifecycle PUTs the whole sandbox to the same
    // update the SDK uses for envs. TODO(B5): verify it keeps the running processes and files.
    const createdAt = Date.parse(sandbox.metadata.createdAt ?? "");
    const endAt = Math.min(Date.now() + (timeoutMs ?? 0), createdAt + BLAXEL_MAX_SESSION_MS);
    if (timeoutMs && endAt > endAtOf(sandbox).getTime()) {
      sandbox = await call(() => SandboxInstance.updateLifecycle(id, lifecycle(endAt)), requestTimeoutMs, "sandbox");
    }
    return wrap(sandbox);
  },
  // `get` is a control-plane read: no resume, no lifetime change.
  inspect: async (id, { requestTimeoutMs } = {}) => wrap(await getRunning(id, requestTimeoutMs)),
  list: async ({ metadata = {}, limit, requestTimeoutMs }) => {
    // Blaxel has no exact label filter: `q` is a substring search over names and
    // labels, so narrow by the longest value and match every label ourselves.
    const q = Object.values(metadata).reduce((longest, value) => (value.length > longest.length ? value : longest), "");
    const matches = (sandbox: SandboxInstance) =>
      isRunning(sandbox) && Object.entries(metadata).every(([key, value]) => sandbox.metadata.labels?.[key] === value);
    const found: ListedSandbox[] = [];
    let page = await call(
      () => SandboxInstance.list({ q: q || undefined, status: "DEPLOYING,DEPLOYED", limit: LIST_PAGE_SIZE, sort: "createdAt:desc" }),
      requestTimeoutMs,
    );
    for (let pages = 1; ; pages++) {
      found.push(...page.data.filter(matches).map((sandbox) => ({ id: sandbox.metadata.name, ...infoOf(sandbox) })));
      if (found.length >= (limit ?? Infinity) || !page.hasMore) return found.slice(0, limit);
      if (pages === MAX_LIST_PAGES) throw new Error(`More than ${MAX_LIST_PAGES * LIST_PAGE_SIZE} Blaxel sandboxes match; refusing to undercount`);
      const next = await call(() => page.nextPage(), requestTimeoutMs);
      if (!next) return found;
      page = next;
    }
  },
  kill,
});
