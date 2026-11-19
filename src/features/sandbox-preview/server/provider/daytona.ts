import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

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

import { quote, runOrThrow } from "./helpers";
import {
  type ListedSandbox,
  type ProviderId,
  type RequestOptions,
  type RunOptions,
  type RunResult,
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
const fromDaytonaError = (error: unknown): unknown => {
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

/**
 * What `run` prints to both streams after the command. Daytona's session logs can end
 * with a newline the command never printed (`printf x` reads back as "x\n"), so `run`
 * cuts each stream at the marker and only the command's own bytes are left. The shell
 * prints it from two halves, so it never appears whole in a command line `/proc` shows.
 */
const END_MARK_HALVES = ["__codenaya_", "run_end__"];
const END_MARK = END_MARK_HALVES.join("");
const printEndMark = `printf %s%s ${END_MARK_HALVES.join(" ")}`;

/** `text` up to the end marker; all of it when the marker never came (a dropped stream). */
const beforeEndMark = (text: string) => {
  const end = text.lastIndexOf(END_MARK);
  return end < 0 ? text : text.slice(0, end);
};

/** Passes chunks to `emit` up to the end marker, holding back a tail that may be its start. */
const untilEndMark = (emit: (chunk: string) => void) => {
  let held = "";
  let ended = false;
  return {
    write: (chunk: string) => {
      if (ended) return;
      const text = held + chunk;
      const end = text.indexOf(END_MARK);
      if (end >= 0) {
        ended = true;
        held = "";
        if (end) emit(text.slice(0, end));
        return;
      }
      let keep = Math.min(text.length, END_MARK.length - 1);
      while (keep && !END_MARK.startsWith(text.slice(-keep))) keep--;
      held = text.slice(text.length - keep);
      if (text.length > keep) emit(text.slice(0, text.length - keep));
    },
    flush: () => {
      if (held) emit(held);
      held = "";
    },
  };
};

/**
 * `command` in bash, after `cd cwd` and `steps`. A session request has no cwd or env.
 * `env` takes any variable name (the /proc restart path passes a whole inherited
 * environment) and, like `exec`, keeps the shell's pid; `timeout` goes between them.
 * `endMark` prints the end marker after the command instead, and keeps its exit code.
 */
const shellCommand = (
  command: string,
  { cwd, envs }: Pick<RunOptions, "cwd" | "envs">,
  { steps = [], timeoutS, endMark = false }: { steps?: string[]; timeoutS?: number; endMark?: boolean } = {},
) => {
  const exec = [
    endMark ? "env --" : "exec env --",
    ...Object.entries(envs ?? {}).map(([key, value]) => quote(`${key}=${value}`)),
    ...(timeoutS ? [`timeout -k 5 ${timeoutS}s`] : []),
    `bash -c ${quote(command)}`,
  ];
  const script = [...(cwd ? [`cd ${quote(cwd)}`] : []), ...steps, exec.join(" ")].join(" && ");
  return `bash -c ${quote(endMark ? `${script}; s=$?; ${printEndMark}; ${printEndMark} >&2; exit $s` : script)}`;
};

/** Retries `read` every `intervalMs` until it returns a value or `budgetMs` runs out. */
const poll = async <T>(read: () => Promise<T | undefined>, budgetMs: number, intervalMs = 100) => {
  const end = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() >= end) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/** Where `start` records each command's pid (session commands report only a command id), and upload manifests go. */
const PID_DIR = "/tmp/.codenaya";

/**
 * File calls without a budget: the SDK's own default is 30 min, which outlasts any
 * caller. A whole-project upload gets longer than a single read.
 */
const READ_TIMEOUT_S = 30;
const UPLOAD_TIMEOUT_S = 120;

/** The exits of a command coreutils `timeout` stopped: TERM, then KILL after the grace period. */
const TIMED_OUT_EXIT_CODES = new Set([124, 137]);

/** How much longer than the command's own limit `run` waits, so `timeout` and its 5 s kill fire first. */
const RUN_WAIT_PAD_MS = 10_000;

/** The seam's view of a Daytona sandbox. */
const wrap = (sandbox: DaytonaSandbox): Sandbox => {
  const { process: processes, fs } = sandbox;

  /** The daemon records the exit code just after the log stream closes, or long after a dropped one. */
  const exitCodeOf = async (sessionId: string, cmdId: string, budgetMs: number) => {
    // `?? undefined`: a running command's exit code may come back as null.
    const exitCode = await poll(
      async () => (await processes.getSessionCommand(sessionId, cmdId)).exitCode ?? undefined,
      budgetMs,
      250,
    );
    if (exitCode === undefined) throw new SandboxTimeoutError("Daytona did not report the command's exit code in time");
    return exitCode;
  };

  // One session per call: Daytona's per-session concurrency is unverified.
  // timeoutMs defaults to 60s, as E2B's commands.run does; 0 means no limit.
  const run = (command: string, { cwd, envs, timeoutMs = 60_000, onStdout, onStderr, requestTimeoutMs }: RunOptions = {}) =>
    call(async (): Promise<RunResult> => {
      const startedAt = Date.now();
      // Always explicit: without one the client's 30 s default would cut the wait short.
      const waitMs = (timeoutMs || DAYTONA_MAX_SESSION_MS) + RUN_WAIT_PAD_MS;
      const remainingMs = () => Math.max(1, startedAt + waitMs - Date.now());
      const sessionId = `cn-run-${randomUUID()}`;
      await withDeadline(processes.createSession(sessionId), requestTimeoutMs);
      try {
        // The session wait is only HTTP, so `timeout` is what stops the command itself.
        const request = { command: shellCommand(command, { cwd, envs }, { timeoutS: seconds(timeoutMs), endMark: true }) };
        let result: RunResult;
        if (!onStdout && !onStderr) {
          // The response carries the exit code and both streams. timeoutMs bounds it, not requestTimeoutMs.
          const response = await processes.executeSessionCommand(sessionId, request, seconds(waitMs));
          const exitCode = response.exitCode ?? (await exitCodeOf(sessionId, response.cmdId, remainingMs()));
          result = { exitCode, stdout: beforeEndMark(response.stdout ?? ""), stderr: beforeEndMark(response.stderr ?? "") };
        } else {
          const pending = processes.executeSessionCommand(sessionId, { ...request, runAsync: true });
          const { cmdId } = await withDeadline(pending, requestTimeoutMs);
          const streamed = { stdout: "", stderr: "" };
          const out = untilEndMark(onStdout ?? noop);
          const err = untilEndMark(onStderr ?? noop);
          await withDeadline(
            processes.getSessionCommandLogs(
              sessionId,
              cmdId,
              (chunk) => { streamed.stdout += chunk; out.write(chunk); },
              (chunk) => { streamed.stderr += chunk; err.write(chunk); },
            ),
            remainingMs(),
          );
          out.flush();
          err.flush();
          // The stream also ends on a dropped socket, so the exit code is polled for the rest of the wait.
          const exitCode = await exitCodeOf(sessionId, cmdId, remainingMs());
          // The full logs, in case the stream dropped early; the streamed output if they fail.
          const logs = await processes.getSessionCommandLogs(sessionId, cmdId).catch(() => streamed);
          result = { exitCode, stdout: beforeEndMark(logs.stdout || streamed.stdout), stderr: beforeEndMark(logs.stderr || streamed.stderr) };
        }
        if (timeoutMs && TIMED_OUT_EXIT_CODES.has(result.exitCode) && Date.now() - startedAt >= timeoutMs) {
          throw new SandboxTimeoutError(`Command timed out after ${timeoutMs} ms`);
        }
        return result;
      } finally {
        // Not awaited: a stalled delete must not hold up the result. It doesn't stop a command
        // still running after a failed wait: `timeout` puts it in its own process group, which
        // the session delete doesn't reach (smoke 4d). Its own timeoutMs still ends it.
        processes.deleteSession(sessionId).catch(noop);
      }
    });

  const seam: Sandbox = {
    provider: DAYTONA_ID,
    id: sandbox.id,
    run,
    start: (command, { cwd, envs, onStdout, onStderr, requestTimeoutMs } = {}) =>
      call(async () => {
        const id = randomUUID();
        const pidFile = `${PID_DIR}/${id}.pid`;
        // Never deleted: the command lives in this session.
        const sessionId = `cn-start-${id}`;
        await processes.createSession(sessionId);
        const { cmdId } = await processes.executeSessionCommand(sessionId, {
          command: shellCommand(command, { cwd, envs }, { steps: [`mkdir -p ${PID_DIR}`, `echo $$ > ${pidFile}`] }),
          runAsync: true,
        });
        if (onStdout || onStderr) {
          // Streams until the command exits; a dropped socket only ends the output.
          processes.getSessionCommandLogs(sessionId, cmdId, onStdout ?? noop, onStderr ?? noop).catch(noop);
        }
        const readPid = () =>
          fs.downloadFile(pidFile, 5).then((data) => Number(data.toString("utf8").trim()) || undefined, () => undefined);
        const pid = await poll(readPid, 5_000);
        if (!pid) {
          // Best effort: whether deleting the session also stops its command is unverified.
          processes.deleteSession(sessionId).catch(noop);
          throw new Error("Daytona did not report the started command's pid");
        }
        return { pid };
      }, requestTimeoutMs),
    writeFiles: async (files, opts = {}) => {
      if (!files.length) return;
      // Whether the upload creates parent directories is unverified, so one mkdir makes them first.
      const dirs = [...new Set([PID_DIR, ...files.map(({ path }) => posix.dirname(path))])];
      await runOrThrow(seam, `mkdir -p -- ${dirs.map(quote).join(" ")}`, opts);
      const uploads = files.map(({ path, data }) => ({
        // A string source is a local file path to the SDK, so the data is always a Buffer.
        // Two branches, so each picks its Buffer.from overload.
        source: typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
        destination: path,
      }));
      // On a serverless runtime (VERCEL=1) the SDK uploads with a fetch whose status it never
      // checks, so a manifest of checksums rides in the same batch and is checked after it.
      // A dropped batch fails too: its manifest is missing.
      const manifest = `${PID_DIR}/upload-${randomUUID()}.sha256`;
      const sums = uploads.map(({ source, destination }) => `${createHash("sha256").update(source).digest("hex")}  ${destination}\n`);
      uploads.push({ source: Buffer.from(sums.join(""), "utf8"), destination: manifest });
      const timeoutS = seconds(opts.requestTimeoutMs) ?? UPLOAD_TIMEOUT_S;
      await call(() => fs.uploadFiles(uploads, timeoutS), opts.requestTimeoutMs);
      await runOrThrow(seam, `sha256sum --check --quiet -- ${quote(manifest)} && rm -f -- ${quote(manifest)}`, opts);
    },
    readFile: (async (path: string, format: "text" | "bytes", opts: RequestOptions = {}) => {
      const data = await call(() => fs.downloadFile(path, seconds(opts.requestTimeoutMs) ?? READ_TIMEOUT_S), opts.requestTimeoutMs);
      return format === "bytes" ? new Uint8Array(data) : data.toString("utf8");
    }) as Sandbox["readFile"],
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
  };
  return seam;
};

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
  const deleteById = async (error: unknown) => {
    if (error instanceof DaytonaTimeoutError && error.sandboxId) await (await daytona().get(error.sandboxId)).delete();
  };
  const deleteOrphan = (error: unknown, pending: Promise<DaytonaSandbox>) => {
    // Our deadline usually wins, and the SDK's own timeout, with the id, arrives later.
    if (error instanceof SandboxTimeoutError) pending.then((sandbox) => sandbox.delete(), deleteById).catch(noop);
    else deleteById(error).catch(noop);
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
        // The list lags, both ways; accepted, and E2B's lag is unmeasured. A new sandbox is missing
        // for about 5 s, so the per-user cap can briefly undercount. A killed one is still listed,
        // and its row still says started, for about 2 s (smoke 7a), so it can briefly overcount.
        // connect and kill read the live state, so acting on such a row is safe.
        for await (const sandbox of daytona().list({ labels: metadata, states: ["started"], limit })) {
          if (!matches(sandbox.labels)) continue;
          listed.push({ id: sandbox.id, ...toInfo(sandbox) });
          if (limit && listed.length >= limit) break;
        }
        return listed;
      }, requestTimeoutMs),
    // delete returns once Daytona accepts it: get() then says destroying, but list keeps it for about 2 s.
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
