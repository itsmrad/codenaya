import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaBadRequestError,
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

/**
 * `connect`'s lifetime extension. Extend-only, as E2B's connect is: `setTtl` re-anchors
 * from now, so it could also shorten a live preview. Never past createdAt + 1 h, the
 * cost guard's hard end, so repeated connects can't keep a sandbox alive; an unknown
 * creation time never extends.
 */
const extendTtl = async (sandbox: DaytonaSandbox, timeoutMs: number) => {
  const now = Date.now();
  const maxMinutes = Math.floor((Date.parse(sandbox.createdAt ?? "") + DAYTONA_MAX_SESSION_MS - now) / 60_000);
  const minutes = Math.min(Math.ceil(timeoutMs / 60_000), maxMinutes);
  if (!(minutes >= 1) || now + minutes * 60_000 <= (Date.parse(sandbox.autoDestroyAt ?? "") || 0)) return;
  await sandbox.setTtl(minutes);
};

/** The label `create` adds for its code interpreter; not one of ours. */
const TOOLBOX_LANGUAGE_LABEL = "code-toolbox-language";

/** A missing `autoDestroyAt` reads as already ended, so the warm-preview lookup skips the sandbox. */
const toInfo = ({ labels, autoDestroyAt }: Pick<DaytonaSandbox, "labels" | "autoDestroyAt">): SandboxInfo => {
  const metadata = { ...labels };
  delete metadata[TOOLBOX_LANGUAGE_LABEL];
  return { metadata, endAt: new Date(autoDestroyAt ?? 0) };
};

const noop = () => {};

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
  // Already gone resolves, as E2B's kill does.
  kill: ({ requestTimeoutMs } = {}) =>
    call(() => sandbox.delete(seconds(requestTimeoutMs)), requestTimeoutMs).catch((error: unknown) => {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }),
  // No listCommands/killCommand: helpers.ts falls back to /proc.
});

/** The snapshot `npm run daytona:snapshot` builds, used when DAYTONA_SNAPSHOT is unset. */
export const DEFAULT_DAYTONA_SNAPSHOT = "codenaya-node22-v1";

const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";

let cached: { key: string; client: Daytona } | undefined;

/** The SDK's own default is 24 h; E2B's is 30 s. Long waits pass their own timeout. */
const DAYTONA_REQUEST_TIMEOUT_MS = 30_000;

/**
 * One client per key and endpoint. The endpoint is always passed, so the SDK's
 * dotenv-ambiguity check can't throw.
 */
const clientFor = (apiKey: string) => {
  const apiUrl = process.env.DAYTONA_API_URL?.trim() || DEFAULT_DAYTONA_API_URL;
  const target = process.env.DAYTONA_TARGET?.trim() || undefined;
  const key = JSON.stringify([apiKey, apiUrl, target]);
  if (cached?.key !== key) cached = { key, client: new Daytona({ apiKey, apiUrl, target, requestTimeoutMs: DAYTONA_REQUEST_TIMEOUT_MS }) };
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

  /**
   * Best effort: a create we stopped waiting for, or one the SDK timed out after its
   * POST, still bills and counts toward the user's sandbox cap until its TTL.
   */
  const deleteOrphan = (error: unknown, pending: Promise<DaytonaSandbox>) => {
    if (error instanceof SandboxTimeoutError) pending.then((sandbox) => sandbox.delete(), noop).catch(noop);
    if (error instanceof DaytonaTimeoutError && error.sandboxId) {
      daytona().get(error.sandboxId).then((sandbox) => sandbox.delete()).catch(noop);
    }
  };

  return {
    id: DAYTONA_ID,
    maxSessionMs: DAYTONA_MAX_SESSION_MS,
    // localHostHeader needs nothing here: the in-sandbox proxy rewrites Host itself.
    create: async ({ image, timeoutMs, metadata, requestTimeoutMs }) => {
      const pending = daytona().create(
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
      );
      try {
        return wrap(await withDeadline(pending, requestTimeoutMs));
      } catch (error) {
        deleteOrphan(error, pending);
        // An unknown snapshot is a 400 or a 404: config, so failover cools Daytona down and moves on.
        if (error instanceof DaytonaBadRequestError || error instanceof DaytonaNotFoundError) {
          throw new SandboxConfigError(error.message, { cause: error });
        }
        throw fromDaytonaError(error);
      }
    },
    connect: (id, { timeoutMs, requestTimeoutMs } = {}) =>
      call(async () => {
        const sandbox = await getRunning(id);
        if (timeoutMs) await extendTtl(sandbox, timeoutMs);
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
        // Callers kill what this returns, so the server's label filter is checked again here.
        const matches = (labels: Record<string, string> = {}) =>
          Object.entries(metadata ?? {}).every(([key, value]) => labels[key] === value);
        const listed: ListedSandbox[] = [];
        for await (const sandbox of daytona().list({ labels: metadata, states: ["started"], limit })) {
          if (!matches(sandbox.labels)) continue;
          listed.push({ id: sandbox.id, ...toInfo(sandbox) });
          if (limit && listed.length >= limit) break;
        }
        return listed;
      }, requestTimeoutMs),
    // delete returns once Daytona accepts it; list filters on started, so the sandbox drops out at once.
    kill: (id, { requestTimeoutMs } = {}) =>
      call(async () => {
        const sandbox = await daytona().get(id);
        // Already being deleted (another tab's kill): deleting again may 409.
        if (sandbox.state === "destroyed" || sandbox.state === "destroying") return false;
        await sandbox.delete(seconds(requestTimeoutMs));
        return true;
      }, requestTimeoutMs).catch((error: unknown) => {
        if (error instanceof SandboxNotFoundError) return false;
        throw error;
      }),
  };
};
