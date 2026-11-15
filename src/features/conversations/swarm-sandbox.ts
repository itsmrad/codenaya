import { CommandExitError, RateLimitError, Sandbox } from "e2b";

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
  SANDBOX_TEMPLATE,
  WORK_DIR,
  writeProjectFiles,
} from "@/features/sandbox-preview/server/project-sandbox";
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

/** The kill switch (default off) and an E2B key; read inside a step, so replays keep the first answer. */
const e2bKey = () =>
  process.env.SWARM_WORKER_SANDBOXES === "true" ? process.env.E2B_API_KEY?.trim() || undefined : undefined;

export const maxWorkerSandboxes = () => {
  const max = Number(process.env.SWARM_MAX_WORKER_SANDBOXES?.trim() || NaN);
  return Number.isInteger(max) && max >= 0 ? Math.min(max, DEFAULT_MAX_WORKER_SANDBOXES) : DEFAULT_MAX_WORKER_SANDBOXES;
};

/** Why a new swarm sandbox may not start now, or undefined when it may. Previews always win. */
// ponytail: check-then-create, so parallel swarms can overshoot by a sandbox or two; E2B's own limit still holds.
const overBudget = async (apiKey: string) => {
  const running = await Sandbox.list({ apiKey, query: { state: ["running"] }, limit: 100 }).nextItems();
  const swarm = running.filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-")).length;
  if (swarm >= SWARM_TEAM_BUDGET) return "sandbox budget in use";
  if (running.length + MAX_LIVE_SANDBOXES >= E2B_TEAM_SANDBOXES) return "previews need the sandboxes";
  return undefined;
};

/** Snapshots need envd 0.5.0 or later in the template. */
const supportsSnapshots = (version: string) => {
  const [major, minor] = version.split(".").map(Number);
  return major > 0 || minor >= 5;
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

/** From the preview template, or from a snapshot of it. */
const createSwarmSandbox = (
  apiKey: string,
  from: string,
  metadata: { projectId: string; messageId: string; purpose: Purpose },
  timeoutMs: number,
) => Sandbox.create(from, { apiKey, metadata, timeoutMs, requestTimeoutMs: CALL_TIMEOUT_MS });

/**
 * The foundation, run as one step beside the workers: installs the current
 * tree in a fresh sandbox, snapshots it, kills it, and stores the snapshot id
 * on the swarm's task rows. Returns the snapshot id, or null when skipped or
 * failed. Never throws.
 */
export const seedSwarmSnapshot = async ({
  internalKey, projectId, messageId,
}: { internalKey: string; projectId: Id<"projects">; messageId: Id<"messages"> }) => {
  const apiKey = e2bKey();
  if (!apiKey || maxWorkerSandboxes() === 0) return null;
  let sandbox: Sandbox | undefined;
  let snapshotId: string | undefined;
  try {
    if (await overBudget(apiKey)) return null;
    sandbox = await createSwarmSandbox(
      apiKey, SANDBOX_TEMPLATE, { projectId, messageId, purpose: "swarm-foundation" }, FOUNDATION_TIMEOUT_MS,
    );
    const { envdVersion } = await sandbox.getInfo({ requestTimeoutMs: CALL_TIMEOUT_MS });
    if (!supportsSnapshots(envdVersion)) return null;
    await writeProjectFiles(sandbox, await projectTextFiles(internalKey, projectId));
    await sandbox.commands.run(DEFAULT_INSTALL_COMMAND, {
      cwd: WORK_DIR, timeoutMs: INSTALL_TIMEOUT_MS, requestTimeoutMs: INSTALL_TIMEOUT_MS,
    });
    snapshotId = (await sandbox.createSnapshot({ requestTimeoutMs: CALL_TIMEOUT_MS })).snapshotId;
    await convex.mutation(api.agentTasks.setSeedSnapshot, { internalKey, messageId, snapshotId });
    return snapshotId;
  } catch (error) {
    // A failed install is the integration build's to report.
    if (!(error instanceof CommandExitError)) console.error("[swarm-sandbox] foundation failed", projectId, error);
    if (snapshotId) await Sandbox.deleteSnapshot(snapshotId, { apiKey }).catch((cleanupError) => {
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
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) return;
  try {
    const running = await Sandbox.list({ apiKey, query: { metadata: { messageId }, state: ["running"] }, limit: 100 })
      .nextItems();
    await Promise.all(running
      .filter(({ metadata }) => metadata?.purpose?.startsWith("swarm-"))
      .map(({ sandboxId }) => Sandbox.kill(sandboxId, { apiKey }).catch(() => false)));
    await Sandbox.deleteSnapshot(snapshotId, { apiKey });
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
  const apiKey = e2bKey();
  if (!apiKey) return { off: true };
  // A worker already at its cost cap leaves the slot to the others.
  if (signal?.aborted) return { skipped: "cost budget" };
  const remaining = invokedAt + timeoutMs - Date.now();
  const maxAttempts = Math.min(SELF_CHECK_ATTEMPTS, Math.floor((remaining - SELF_CHECK_SLACK_MS) / CHECK_ROUND_MS) - 1);
  // verifyAndFix always allows at least one repair, which needs two verifies plus slack.
  if (maxAttempts < 1) return { skipped: "time budget" };
  let sandbox: Sandbox | undefined;
  try {
    const budget = await overBudget(apiKey);
    if (budget) return { skipped: budget };
    const claim = await convex.mutation(api.agentTasks.claimSelfCheck, {
      internalKey, agentTaskId, max: maxWorkerSandboxes(),
    });
    if (claim.skipped !== undefined) return { skipped: claim.skipped };
    // E2B expires it after the reserved check budget even if cleanup is lost.
    sandbox = await createSwarmSandbox(
      apiKey, claim.seedSnapshotId, { projectId, messageId, purpose: "swarm-worker" },
      (maxAttempts + 1) * CHECK_ROUND_MS + SELF_CHECK_SLACK_MS,
    );
    // shortcut: files deleted since the snapshot stay in the sandbox; rare within one swarm.
    await writeProjectFiles(sandbox, await projectTextFiles(internalKey, projectId));
    return { sandboxId: sandbox.sandboxId, maxAttempts };
  } catch (error) {
    console.error("[swarm-sandbox] worker start failed", projectId, error);
    await sandbox?.kill().catch(() => {});
    return { skipped: error instanceof RateLimitError ? "E2B rate limit" : "sandbox unavailable" };
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
    sandbox: () => Sandbox.connect(started.sandboxId, { apiKey: process.env.E2B_API_KEY?.trim() }),
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
    await Sandbox.kill(started.sandboxId, { apiKey: process.env.E2B_API_KEY?.trim() }).catch(() => false);
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
