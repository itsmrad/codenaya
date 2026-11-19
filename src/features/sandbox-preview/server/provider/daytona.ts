import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaCommandAlreadyCompletedError,
  DaytonaConnectionTimeoutError,
  DaytonaFileAccessDeniedError,
  DaytonaFileNotFoundError,
  DaytonaForbiddenError,
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaProcessNotFoundError,
  DaytonaRateLimitError,
  DaytonaSessionEndedError,
  DaytonaTimeoutError,
  type Sandbox as DaytonaSandbox,
} from "@daytona/sdk";

import {
  type ListedSandbox,
  type ProviderId,
  type Sandbox,
  SandboxConfigError,
  type SandboxInfo,
  SandboxNotFoundError,
  type SandboxProvider,
  SandboxRateLimitError,
  SandboxTimeoutError,
} from "./types";

// shortcut: ProviderId is still ["e2b"], and a literal can't be cast to another literal directly.
// The register PR adds "daytona" to PROVIDER_IDS and drops this cast.
const DAYTONA_ID = "daytona" as string as ProviderId;

/** Toolbox errors about one file, process or session: not the sandbox being gone or the account being refused. */
const PASS_THROUGH = [
  DaytonaFileNotFoundError,
  DaytonaFileAccessDeniedError,
  DaytonaProcessNotFoundError,
  DaytonaSessionEndedError,
  DaytonaCommandAlreadyCompletedError,
];

/** Translates Daytona's errors into the seam's; anything else is rethrown as is. */
export const fromDaytonaError = (error: unknown): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  if (PASS_THROUGH.some((type) => error instanceof type)) return error;
  // Forbidden covers the deprecated DaytonaAuthorizationError, a subclass.
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError) {
    return new SandboxConfigError(message, { cause: error });
  }
  if (error instanceof DaytonaRateLimitError) return new SandboxRateLimitError(message, { cause: error });
  // Timeout covers DaytonaQueueTimeoutError, a subclass; the connection timeout sits under DaytonaConnectionError.
  if (error instanceof DaytonaTimeoutError || error instanceof DaytonaConnectionTimeoutError) {
    return new SandboxTimeoutError(message, { cause: error });
  }
  if (error instanceof DaytonaNotFoundError || error instanceof DaytonaGoneError) {
    return new SandboxNotFoundError(message, { cause: error });
  }
  return error;
};

/**
 * The SDK takes a request timeout per client, not per call, so the seam's
 * `requestTimeoutMs` races the call instead. The request itself is not aborted.
 */
export const withDeadline = <T>(promise: Promise<T>, ms?: number): Promise<T> => {
  if (!ms) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxTimeoutError(`Daytona request timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const call = async <T>(request: () => Promise<T>, requestTimeoutMs?: number): Promise<T> => {
  try {
    return await withDeadline(request(), requestTimeoutMs);
  } catch (error) {
    throw fromDaytonaError(error);
  }
};

/** Daytona's timeouts are in seconds; absent or 0 keeps the SDK's default. */
const seconds = (ms?: number) => (ms ? Math.ceil(ms / 1000) : undefined);

/** Our policy, not a Daytona cap: the same one-hour lifetime as E2B. */
const DAYTONA_MAX_SESSION_MS = 60 * 60 * 1000;

/**
 * Cost guard: the TTL is Daytona's wall-clock hard delete and 0 would disable it,
 * so it is always 1 to 60 minutes.
 */
export const ttlMinutes = (timeoutMs: number) =>
  Math.min(Math.max(1, Math.ceil(timeoutMs / 60_000)), DAYTONA_MAX_SESSION_MS / 60_000);

/** The label `create` adds for its code interpreter; not one of ours. */
const TOOLBOX_LANGUAGE_LABEL = "code-toolbox-language";

/** A missing `autoDestroyAt` reads as already ended, so the warm-preview lookup skips the sandbox. */
const toInfo = ({ labels, autoDestroyAt }: Pick<DaytonaSandbox, "labels" | "autoDestroyAt">): SandboxInfo => {
  const metadata = { ...labels };
  delete metadata[TOOLBOX_LANGUAGE_LABEL];
  return { metadata, endAt: new Date(autoDestroyAt ?? 0) };
};

const notImplemented = async (): Promise<never> => {
  throw new Error("not implemented");
};

/** The seam's view of a Daytona sandbox. */
const wrap = (sandbox: DaytonaSandbox): Sandbox => ({
  provider: DAYTONA_ID,
  id: sandbox.id,
  // D2 implements exec and files.
  run: notImplemented,
  start: notImplemented,
  writeFiles: notImplemented,
  readFile: notImplemented as Sandbox["readFile"],
  // The sandbox is public, so the URL needs no token. Never return or log `.token`:
  // it also unlocks the toolbox and the terminal.
  previewUrl: async (port) => (await call(() => sandbox.getPreviewLink(port))).url,
  info: ({ requestTimeoutMs } = {}) =>
    call(async () => {
      await sandbox.refreshData();
      return toInfo(sandbox);
    }, requestTimeoutMs),
  kill: ({ requestTimeoutMs } = {}) => call(() => sandbox.delete(seconds(requestTimeoutMs)), requestTimeoutMs),
  // No listCommands/killCommand: helpers.ts falls back to /proc.
});

/** The snapshot `npm run daytona:snapshot` builds, used when DAYTONA_SNAPSHOT is unset. */
export const DEFAULT_DAYTONA_SNAPSHOT = "codenaya-node22-v1";

const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";

let cached: { key: string; client: Daytona } | undefined;

/**
 * One client per key and endpoint. The endpoint is always passed, so the SDK never
 * resolves it from a `.env` file in cwd (it throws when that is ambiguous).
 */
const clientFor = (apiKey: string) => {
  const apiUrl = process.env.DAYTONA_API_URL?.trim() || DEFAULT_DAYTONA_API_URL;
  const target = process.env.DAYTONA_TARGET?.trim() || undefined;
  const key = JSON.stringify([apiKey, apiUrl, target]);
  if (cached?.key !== key) cached = { key, client: new Daytona({ apiKey, apiUrl, target }) };
  return cached.client;
};

/** The Daytona adapter. `apiKey` is read by the registry per request. */
export const createDaytonaProvider = (apiKey: string): SandboxProvider => {
  const daytona = () => clientFor(apiKey);

  /** Ephemeral sandboxes are deleted when they stop, so any other state is as good as gone. */
  const getRunning = async (id: string) => {
    const sandbox = await daytona().get(id);
    if (sandbox.state !== "started") throw new SandboxNotFoundError("Preview is not running");
    return sandbox;
  };

  return {
    id: DAYTONA_ID,
    maxSessionMs: DAYTONA_MAX_SESSION_MS,
    // localHostHeader needs nothing here: the in-sandbox proxy rewrites Host itself.
    create: ({ image, timeoutMs, metadata, requestTimeoutMs }) =>
      call(
        () =>
          daytona().create(
            {
              // Read per call, like E2B_TEMPLATE.
              snapshot: image ?? (process.env.DAYTONA_SNAPSHOT?.trim() || DEFAULT_DAYTONA_SNAPSHOT),
              // A copy: create adds its language label to the object it is given.
              labels: { ...metadata },
              public: true,
              // Off: a background dev server is not activity, so an idle preview would stop after 15 min.
              autoStopInterval: 0,
              ephemeral: true,
              ttlMinutes: ttlMinutes(timeoutMs),
            },
            { timeout: seconds(requestTimeoutMs) },
          ),
        requestTimeoutMs,
      ).then(wrap),
    connect: (id, { timeoutMs, requestTimeoutMs } = {}) =>
      call(async () => {
        const sandbox = await getRunning(id);
        // setTtl re-anchors the deadline from now, as E2B's connect extends the timeout.
        if (timeoutMs) await sandbox.setTtl(ttlMinutes(timeoutMs));
        return wrap(sandbox);
      }, requestTimeoutMs),
    inspect: (id, { requestTimeoutMs } = {}) =>
      call(async () => {
        // GET only: neither the TTL nor the activity timer moves.
        const sandbox = await getRunning(id);
        if (toInfo(sandbox).endAt.getTime() <= Date.now()) throw new SandboxNotFoundError("Preview is not running");
        return wrap(sandbox);
      }, requestTimeoutMs),
    // The SDK pages on its own (`limit` is its page size), so this stops at `limit`; without one it reads every page.
    list: ({ metadata, limit, requestTimeoutMs }) =>
      call(async () => {
        const listed: ListedSandbox[] = [];
        for await (const sandbox of daytona().list({ labels: metadata, states: ["started"], limit })) {
          listed.push({ id: sandbox.id, ...toInfo(sandbox) });
          if (limit && listed.length >= limit) break;
        }
        return listed;
      }, requestTimeoutMs),
    // delete returns once Daytona accepts it; list filters on started, so the sandbox drops out at once.
    kill: (id, { requestTimeoutMs } = {}) =>
      call(async () => {
        await (await daytona().get(id)).delete(seconds(requestTimeoutMs));
        return true;
      }, requestTimeoutMs).catch((error: unknown) => {
        if (error instanceof SandboxNotFoundError) return false;
        throw error;
      }),
  };
};
