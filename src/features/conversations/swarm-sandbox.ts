import {
  type BuildError,
  type RepairEvent,
  type VerifyAndFixOptions,
  verifyAndFix,
} from "@/features/conversations/server/sandbox-repair";
import {
  DEFAULT_INSTALL_COMMAND,
  MAX_LIVE_SANDBOXES,
  type ProjectFile,
  WORK_DIR,
  projectFileEntries,
} from "@/features/sandbox-preview/server/project-sandbox";
import { killListed, listAll } from "@/features/sandbox-preview/server/provider/fanout";
import { runOrThrow } from "@/features/sandbox-preview/server/provider/helpers";
import { parsePublicSandboxIdOrNull, toPublicSandboxId } from "@/features/sandbox-preview/server/provider/ids";
import { type SandboxPool, getSandboxPool } from "@/features/sandbox-preview/server/provider/registry";
import {
  PROVIDER_IDS,
  type ProviderId,
  type Sandbox,
  SandboxConfigError,
  type SandboxMeta,
  type SandboxProvider,
  SandboxRateLimitError,
} from "@/features/sandbox-preview/server/provider/types";
import { convex } from "@/lib/convex-client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { withoutSecretFiles } from "../../../convex/secretFiles";
import { type AgentStep, buildPathIndex } from "./agent-steps";
import { WORKER_TIMEOUT_MS, ownsPath } from "./swarm";

/**
 * Optional per-worker self-check (ADR 0013, S6): a foundation sandbox is
 * installed once per swarm and snapshotted; up to SWARM_MAX_WORKER_SANDBOXES
 * workers then check and repair their own files in a sandbox started from it.
 * Its result is advisory ("scoped-ok", never "verified"): the orchestrator's
 * unfiltered integration build stays the only verified signal.
 *
 * The foundation runs on the primary provider when it snapshots, and every
 * worker on the provider that made the snapshot: a snapshot id works nowhere else.
 */

/** Concurrent sandboxes per provider account: E2B Hobby's (the plan is unknown) and Blaxel Tier 0's. */
const TEAM_SANDBOXES = 10;
/** Swarm sandboxes running team-wide at most, so previews always have room. */
const SWARM_TEAM_BUDGET = 4;
const DEFAULT_MAX_WORKER_SANDBOXES = 2;
const FOUNDATION_TIMEOUT_MS = 5 * 60_000;
/**
 * One verify, including the final recheck: swarm builds take 115-130 s (check-build.ts).
 * A slower check stops at the worker's own deadline (`deadline` below), not its 240 s budget.
 */
const CHECK_ROUND_MS = 150_000;
/** Room for setup, syncing and model turns; a slow in-flight call can still overrun. */
const SELF_CHECK_SLACK_MS = 60_000;
/** Inside the foundation step's ~240 s, with room for create, write and snapshot. */
const INSTALL_TIMEOUT_MS = 150_000;
const CALL_TIMEOUT_MS = 30_000;
/** Self-check repairs after the first check. */
const SELF_CHECK_ATTEMPTS = 2;

type Purpose = "swarm-foundation" | "swarm-worker";

export type SelfCheck = { selfCheck: string; filesChanged: string[] };

type SnapshotProvider = SandboxProvider & Required<Pick<SandboxProvider, "snapshot" | "createFromSnapshot" | "deleteSnapshot">>;

const hasSnapshots = (provider: SandboxProvider | null): provider is SnapshotProvider =>
  !!(provider?.snapshot && provider.createFromSnapshot && provider.deleteSnapshot);

/**
 * The kill switch (default off), the configured providers, and the primary one
 * when it snapshots; read inside a step, so replays keep the first answer.
 */
const swarmProviders = (): { pool: SandboxPool; home: SnapshotProvider } | null => {
  if (process.env.SWARM_WORKER_SANDBOXES !== "true") return null;
  const pool = getSandboxPool();
  const home = pool?.providers.find(({ id }) => id === pool.health?.primary) ?? null;
  return pool && hasSnapshots(home) ? { pool, home } : null;
};

/**
 * The stored snapshot id names its provider, as a public sandbox id does
 * (`blaxel:<id>`); E2B's stays bare, as it was before other providers.
 */
const snapshotRef = (provider: ProviderId, id: string) => (provider === "e2b" ? id : `${provider}:${id}`);

const parseSnapshotRef = (ref: string): { provider: ProviderId; id: string } => {
  const separator = ref.indexOf(":");
  const prefix = ref.slice(0, Math.max(separator, 0));
  return (PROVIDER_IDS as readonly string[]).includes(prefix)
    ? { provider: prefix as ProviderId, id: ref.slice(separator + 1) }
    : { provider: "e2b", id: ref };
};

/** The provider and native id behind a worker's public sandbox id, while that provider is configured. */
const workerSandboxOrNull = (publicId: string) => {
  // An unprefixed id (a step memoized before ids carried their provider) is E2B's.
  const target = parsePublicSandboxIdOrNull(publicId);
  const provider = target && getSandboxPool()?.providers.find(({ id }) => id === target.provider);
  return target && provider ? { provider, nativeId: target.nativeId } : null;
};

export const maxWorkerSandboxes = () => {
  const max = Number(process.env.SWARM_MAX_WORKER_SANDBOXES?.trim() || NaN);
  return Number.isInteger(max) && max >= 0 ? Math.min(max, DEFAULT_MAX_WORKER_SANDBOXES) : DEFAULT_MAX_WORKER_SANDBOXES;
};

/** Why a new swarm sandbox may not start now, or undefined when it may. Previews always win. */
// ponytail: check-then-create, so parallel swarms can overshoot by a sandbox or two; the provider's own limit still holds.
const overBudget = async (provider: SandboxProvider) => {
  const running = await provider.list({ limit: 100 });
  const swarm = running.filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-")).length;
  if (swarm >= SWARM_TEAM_BUDGET) return "sandbox budget in use";
  if (running.length + MAX_LIVE_SANDBOXES >= TEAM_SANDBOXES) return "previews need the sandboxes";
  return undefined;
};

/** The project's text files from Convex, by path, without secret files. */
const projectTextFiles = async (internalKey: string, projectId: Id<"projects">) => {
  const rows = await convex.query(api.files.getBuildFiles, { internalKey, projectId });
  const pathOf = buildPathIndex(rows);
  return withoutSecretFiles(rows.flatMap((row): ProjectFile[] => {
    const path = row.type === "file" ? pathOf(row._id) : undefined;
    return path && typeof row.content === "string" ? [{ path, content: row.content }] : [];
  }));
};

type SwarmMeta = SandboxMeta & { projectId: string; messageId: string; purpose: Purpose };

/** From the preview template (no snapshot id), or from a snapshot of it. */
const createSwarmSandbox = (provider: SnapshotProvider, snapshotId: string | null, metadata: SwarmMeta, timeoutMs: number) => {
  const opts = { metadata, timeoutMs, requestTimeoutMs: CALL_TIMEOUT_MS };
  return snapshotId !== null ? provider.createFromSnapshot(snapshotId, opts) : provider.create(opts);
};

/**
 * The foundation, run as one step beside the workers: installs the current
 * tree in a fresh sandbox, snapshots it, kills it, and stores the snapshot id,
 * with its provider, on the swarm's task rows. Returns that stored id, or null
 * when skipped or failed. Never throws.
 */
export const seedSwarmSnapshot = async ({
  internalKey, projectId, messageId,
}: { internalKey: string; projectId: Id<"projects">; messageId: Id<"messages"> }) => {
  const provider = swarmProviders()?.home;
  if (!provider || maxWorkerSandboxes() === 0) return null;
  let sandbox: Sandbox | undefined;
  let snapshotId: string | undefined;
  try {
    if (await overBudget(provider)) return null;
    sandbox = await createSwarmSandbox(
      provider, null, { projectId, messageId, purpose: "swarm-foundation" }, FOUNDATION_TIMEOUT_MS,
    );
    if ((await sandbox.info({ requestTimeoutMs: CALL_TIMEOUT_MS })).canSnapshot === false) return null;
    const files = await projectTextFiles(internalKey, projectId);
    // An empty batch writes nothing, so the install still needs its directory.
    if (files.length) await sandbox.writeFiles(projectFileEntries(files));
    else await runOrThrow(sandbox, `mkdir -p ${WORK_DIR}`);
    const install = await sandbox.run(DEFAULT_INSTALL_COMMAND, {
      cwd: WORK_DIR, timeoutMs: INSTALL_TIMEOUT_MS, requestTimeoutMs: INSTALL_TIMEOUT_MS,
    });
    // A failed install is the integration build's to report.
    if (install.exitCode !== 0) return null;
    snapshotId = await provider.snapshot(sandbox, { requestTimeoutMs: CALL_TIMEOUT_MS });
    const ref = snapshotRef(provider.id, snapshotId);
    await convex.mutation(api.agentTasks.setSeedSnapshot, { internalKey, messageId, snapshotId: ref });
    return ref;
  } catch (error) {
    console.error("[swarm-sandbox] foundation failed", projectId, error);
    if (snapshotId) await provider.deleteSnapshot(snapshotId).catch((cleanupError) => {
      console.error("[swarm-sandbox] snapshot cleanup failed", projectId, cleanupError);
    });
    return null;
  } finally {
    await sandbox?.kill().catch(() => {});
  }
};

/**
 * After every worker settled: kills the swarm's leftover sandboxes on every
 * configured provider (the fan-out kill policy), then deletes its snapshot on
 * the provider that made it. Never throws.
 */
// shortcut: a cancelled run never gets here, so its snapshot stays; sweep old snapshots if that adds up.
export const cleanupSwarmSandboxes = async ({ messageId, snapshotId }: { messageId: string; snapshotId: string }) => {
  const pool = getSandboxPool();
  if (!pool) return;
  const { providers, health } = pool;
  try {
    const running = await listAll(providers, { metadata: { messageId }, limit: 100 }, health && { ...health, skip: "failing" });
    await killListed(providers, running.filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-")), health, "swarm sandbox");
  } catch (error) {
    console.error("[swarm-sandbox] cleanup failed", messageId, error);
  }
  const { provider, id } = parseSnapshotRef(snapshotId);
  await providers.find((candidate) => candidate.id === provider)?.deleteSnapshot?.(id).catch((error) => {
    console.error("[swarm-sandbox] snapshot cleanup failed", messageId, error);
  });
};

type StartResult = { sandboxId: string; maxAttempts: number } | { skipped: string } | { off: true };

/**
 * Claims one of the swarm's self-check slots and starts a sandbox from the
 * foundation snapshot with the project's current files. Run inside a step.
 */
const startWorkerSandbox = async ({
  internalKey, projectId, messageId, agentTaskId, invokedAt, timeoutMs, signal,
}: {
  internalKey: string; projectId: Id<"projects">; messageId: Id<"messages">; agentTaskId: Id<"agentTasks">;
  invokedAt: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<StartResult> => {
  const providers = swarmProviders();
  if (!providers) return { off: true };
  const { pool, home } = providers;
  // A worker already at its cost cap leaves the slot to the others.
  if (signal?.aborted) return { skipped: "cost budget" };
  const remaining = invokedAt + timeoutMs - Date.now();
  // Each repair needs one more verify; with room for one verify only, it checks without repairing.
  const maxAttempts = Math.min(SELF_CHECK_ATTEMPTS, Math.floor((remaining - SELF_CHECK_SLACK_MS) / CHECK_ROUND_MS) - 1);
  if (maxAttempts < 0) return { skipped: "time budget" };
  let provider = home;
  let sandbox: Sandbox | undefined;
  try {
    const budget = await overBudget(home);
    if (budget) return { skipped: budget };
    const claim = await convex.mutation(api.agentTasks.claimSelfCheck, {
      internalKey, agentTaskId, max: maxWorkerSandboxes(),
    });
    if (claim.skipped !== undefined) return { skipped: claim.skipped };
    // Only the provider that made the snapshot can start from it.
    const snapshot = parseSnapshotRef(claim.seedSnapshotId);
    const owner = pool.providers.find(({ id }) => id === snapshot.provider) ?? null;
    if (!hasSnapshots(owner)) return { skipped: "sandbox unavailable" };
    if (owner !== home) {
      provider = owner;
      const ownerBudget = await overBudget(owner);
      if (ownerBudget) return { skipped: ownerBudget };
    }
    // The provider expires it after the reserved check budget even if cleanup is lost.
    sandbox = await createSwarmSandbox(
      provider, snapshot.id, { projectId, messageId, purpose: "swarm-worker" },
      (maxAttempts + 1) * CHECK_ROUND_MS + SELF_CHECK_SLACK_MS,
    );
    // shortcut: files deleted since the snapshot stay in the sandbox; rare within one swarm.
    await sandbox.writeFiles(projectFileEntries(await projectTextFiles(internalKey, projectId)));
    return { sandboxId: toPublicSandboxId(sandbox.provider, sandbox.id), maxAttempts };
  } catch (error) {
    console.error("[swarm-sandbox] worker start failed", projectId, error);
    await sandbox?.kill().catch(() => {});
    return { skipped: error instanceof SandboxRateLimitError ? `${provider.id.toUpperCase()} rate limit` : "sandbox unavailable" };
  }
};

/** Static check errors name their file only in the text, as "(referenced by src/x.tsx)". */
const errorFile = ({ file, message }: BuildError) => file ?? /\((?:referenced|imported) by ([^)\s]+)\)/.exec(message)?.[1];

export const ownedErrors = (ownedPaths: readonly string[]) => (errors: BuildError[]) =>
  errors.filter((error) => {
    const file = errorFile(error);
    return file !== undefined && ownsPath(ownedPaths, file);
  });

/** A repair event as a step on the task's trail. Never shown as BUILD_VERIFIED. */
export const selfCheckStep = (event: RepairEvent, now: number): AgentStep => ({
  id: `self-check:${event.id}`,
  kind: "tool",
  tool: event.phase === "verify" ? "checkBuild" : "editFile",
  ...(event.filesChanged?.length ? { targets: event.filesChanged } : {}),
  text: event.phase === "verify" ? "Self-checked its files" : "Repaired its files",
  status: event.status,
  ...(event.status === "error" ? { error: event.reason ? "Self-check could not complete" : `${event.errors?.length ?? 0} build error(s)` } : {}),
  startedAt: now,
  ...(event.status === "running" ? {} : { endedAt: now }),
});

type Step = { run: (id: string, fn: () => unknown) => Promise<unknown> };

/**
 * A worker's self-check, called from the swarm-worker function body (never
 * inside step.run) after its network ends. Null while the switch is off;
 * skipped unless the snapshot is ready, a swarm slot is free and the team
 * budget allows it.
 */
export const selfCheckWorker = async ({
  step, internalKey, projectId, messageId, agentTaskId, ownedPaths, invokedAt, timeoutMs = WORKER_TIMEOUT_MS,
  model, onEvent, onResponse, signal,
}: {
  step: Step;
  internalKey: string;
  projectId: Id<"projects">;
  messageId: Id<"messages">;
  agentTaskId: Id<"agentTasks">;
  ownedPaths: string[];
  /** When step.invoke started this task's timeout. */
  invokedAt: number;
  timeoutMs?: number;
  model: VerifyAndFixOptions["model"];
  onEvent: (event: RepairEvent) => Promise<void>;
  onResponse: NonNullable<VerifyAndFixOptions["onResponse"]>;
  signal?: AbortSignal;
}): Promise<SelfCheck | null> => {
  const started = (await step.run("self-check-start", () =>
    startWorkerSandbox({ internalKey, projectId, messageId, agentTaskId, invokedAt, timeoutMs, signal }))) as StartResult;
  if ("off" in started) return null;
  if ("skipped" in started) return { selfCheck: `skipped (${started.skipped})`, filesChanged: [] };

  const owns = (path: string) => ownsPath(ownedPaths, path);
  // Stop repairing once no full verify fits before step.invoke's timeout; the slack alone can't cover a round.
  const deadline = new AbortController();
  const deadlineAt = invokedAt + timeoutMs - CHECK_ROUND_MS;
  const repairSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const result = await verifyAndFix({
    sandbox: async () => {
      const target = workerSandboxOrNull(started.sandboxId);
      if (!target) throw new SandboxConfigError("The worker sandbox's provider is not configured");
      return target.provider.connect(target.nativeId);
    },
    projectId,
    internalKey,
    runId: messageId,
    messageId,
    agentTaskId,
    model,
    // Started from project files only, never variables or secret files: no value to print.
    secrets: [],
    maxAttempts: started.maxAttempts,
    // A check in flight stops before step.invoke's timeout, so the worker still returns its report.
    deadline: invokedAt + timeoutMs - SELF_CHECK_SLACK_MS,
    filterErrors: ownedErrors(ownedPaths),
    allowedPaths: owns,
    onEvent,
    onResponse,
    signal: repairSignal,
    step: async (id, fn) => {
      if (await step.run(`${id}-late`, () => Date.now() >= deadlineAt)) deadline.abort();
      return step.run(id, fn);
    },
  });
  await step.run("self-check-stop", async () => {
    const target = workerSandboxOrNull(started.sandboxId);
    await target?.provider.kill(target.nativeId).catch(() => false);
  });
  const ownedLeft = ownedErrors(ownedPaths)(result.errors).length;
  if (result.status === "unverified" && result.reason && !repairSignal.aborted) {
    console.error("[swarm-sandbox] check incomplete", projectId, result.reason);
  }
  // A full pass of a partial tree proves only this worker's files: still scoped.
  const selfCheck = result.status === "verified" || result.status === "scoped-ok"
    ? "scoped-ok"
    : result.status === "failed"
      ? `scoped-failed (${ownedLeft} in owned files)`
      : `skipped (${signal?.aborted ? "cost budget" : deadline.signal.aborted ? "time budget" : "check unavailable"})`;
  return { selfCheck, filesChanged: result.filesChanged };
};
