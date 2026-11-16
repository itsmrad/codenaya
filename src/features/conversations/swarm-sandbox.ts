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
import { runOrThrow } from "@/features/sandbox-preview/server/provider/helpers";
import { getDefaultProvider, getDefaultProviderOrNull } from "@/features/sandbox-preview/server/provider/registry";
import {
  type Sandbox,
  type SandboxMeta,
  type SandboxProvider,
  SandboxRateLimitError,
} from "@/features/sandbox-preview/server/provider/types";
import { convex } from "@/lib/convex-client";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { type AgentStep, buildPathIndex } from "./agent-steps";
import { WORKER_TIMEOUT_MS, ownsPath } from "./swarm";

/**
 * Optional per-worker self-check (ADR 0013, S6): a foundation sandbox is
 * installed once per swarm and snapshotted; up to SWARM_MAX_WORKER_SANDBOXES
 * workers then check and repair their own files in a sandbox started from it.
 * Its result is advisory ("scoped-ok", never "verified"): the orchestrator's
 * unfiltered integration build stays the only verified signal.
 */

/** Concurrent sandboxes on the E2B team; the plan is unknown, so Hobby's. */
const E2B_TEAM_SANDBOXES = 10;
/** Swarm sandboxes running team-wide at most, so previews always have room. */
const SWARM_TEAM_BUDGET = 4;
const DEFAULT_MAX_WORKER_SANDBOXES = 2;
const FOUNDATION_TIMEOUT_MS = 5 * 60_000;
/** Each verify can use the check's full 240 s budget, including the final recheck. */
const CHECK_ROUND_MS = 4 * 60_000;
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
 * The kill switch (default off) and a configured provider that snapshots; read
 * inside a step, so replays keep the first answer.
 */
const swarmProvider = () => {
  if (process.env.SWARM_WORKER_SANDBOXES !== "true") return null;
  const provider = getDefaultProviderOrNull();
  return hasSnapshots(provider) ? provider : null;
};

export const maxWorkerSandboxes = () => {
  const max = Number(process.env.SWARM_MAX_WORKER_SANDBOXES?.trim() || NaN);
  return Number.isInteger(max) && max >= 0 ? Math.min(max, DEFAULT_MAX_WORKER_SANDBOXES) : DEFAULT_MAX_WORKER_SANDBOXES;
};

/** Why a new swarm sandbox may not start now, or undefined when it may. Previews always win. */
// ponytail: check-then-create, so parallel swarms can overshoot by a sandbox or two; E2B's own limit still holds.
const overBudget = async (provider: SandboxProvider) => {
  const running = await provider.list({ limit: 100 });
  const swarm = running.filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-")).length;
  if (swarm >= SWARM_TEAM_BUDGET) return "sandbox budget in use";
  if (running.length + MAX_LIVE_SANDBOXES >= E2B_TEAM_SANDBOXES) return "previews need the sandboxes";
  return undefined;
};

/** The project's text files from Convex, by path. */
const projectTextFiles = async (internalKey: string, projectId: Id<"projects">) => {
  const rows = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
  const pathOf = buildPathIndex(rows);
  return rows.flatMap((row): ProjectFile[] => {
    const path = row.type === "file" ? pathOf(row._id) : undefined;
    return path && typeof row.content === "string" ? [{ path, content: row.content }] : [];
  });
};

type SwarmMeta = SandboxMeta & { projectId: string; messageId: string; purpose: Purpose };

/** From the preview template (no snapshot id), or from a snapshot of it. */
const createSwarmSandbox = (provider: SnapshotProvider, snapshotId: string | null, metadata: SwarmMeta, timeoutMs: number) => {
  const opts = { metadata, timeoutMs, requestTimeoutMs: CALL_TIMEOUT_MS };
  return snapshotId !== null ? provider.createFromSnapshot(snapshotId, opts) : provider.create(opts);
};

/**
 * The foundation, run as one step beside the workers: installs the current
 * tree in a fresh sandbox, snapshots it, kills it, and stores the snapshot id
 * on the swarm's task rows. Returns the snapshot id, or null when skipped or
 * failed. Never throws.
 */
export const seedSwarmSnapshot = async ({
  internalKey, projectId, messageId,
}: { internalKey: string; projectId: Id<"projects">; messageId: Id<"messages"> }) => {
  const provider = swarmProvider();
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
    await convex.mutation(api.agentTasks.setSeedSnapshot, { internalKey, messageId, snapshotId });
    return snapshotId;
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

/** After every worker settled: kills the swarm's leftover sandboxes and deletes its snapshot. Never throws. */
// shortcut: a cancelled run never gets here, so its snapshot stays; sweep old snapshots if that adds up.
export const cleanupSwarmSandboxes = async ({ messageId, snapshotId }: { messageId: string; snapshotId: string }) => {
  const provider = getDefaultProviderOrNull();
  if (!provider) return;
  try {
    const running = await provider.list({ metadata: { messageId }, limit: 100 });
    await Promise.all(running
      .filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-"))
      .map(({ id }) => provider.kill(id).catch(() => false)));
    await provider.deleteSnapshot?.(snapshotId);
  } catch (error) {
    console.error("[swarm-sandbox] cleanup failed", messageId, error);
  }
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
  const provider = swarmProvider();
  if (!provider) return { off: true };
  // A worker already at its cost cap leaves the slot to the others.
  if (signal?.aborted) return { skipped: "cost budget" };
  const remaining = invokedAt + timeoutMs - Date.now();
  const maxAttempts = Math.min(SELF_CHECK_ATTEMPTS, Math.floor((remaining - SELF_CHECK_SLACK_MS) / CHECK_ROUND_MS) - 1);
  // verifyAndFix always allows at least one repair, which needs two verifies plus slack.
  if (maxAttempts < 1) return { skipped: "time budget" };
  let sandbox: Sandbox | undefined;
  try {
    const budget = await overBudget(provider);
    if (budget) return { skipped: budget };
    const claim = await convex.mutation(api.agentTasks.claimSelfCheck, {
      internalKey, agentTaskId, max: maxWorkerSandboxes(),
    });
    if (claim.skipped !== undefined) return { skipped: claim.skipped };
    // E2B expires it after the reserved check budget even if cleanup is lost.
    sandbox = await createSwarmSandbox(
      provider, claim.seedSnapshotId, { projectId, messageId, purpose: "swarm-worker" },
      (maxAttempts + 1) * CHECK_ROUND_MS + SELF_CHECK_SLACK_MS,
    );
    // shortcut: files deleted since the snapshot stay in the sandbox; rare within one swarm.
    await sandbox.writeFiles(projectFileEntries(await projectTextFiles(internalKey, projectId)));
    return { sandboxId: sandbox.id, maxAttempts };
  } catch (error) {
    console.error("[swarm-sandbox] worker start failed", projectId, error);
    await sandbox?.kill().catch(() => {});
    return { skipped: error instanceof SandboxRateLimitError ? "E2B rate limit" : "sandbox unavailable" };
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
    sandbox: () => getDefaultProvider().connect(started.sandboxId),
    projectId,
    internalKey,
    runId: messageId,
    agentTaskId,
    model,
    maxAttempts: started.maxAttempts,
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
    await getDefaultProviderOrNull()?.kill(started.sandboxId).catch(() => false);
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
