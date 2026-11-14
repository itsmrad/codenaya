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
/** E2B kills a worker's sandbox after this even if the stop step is lost or the run cancelled. */
const WORKER_SANDBOX_TIMEOUT_MS = 10 * 60_000;
/** One check plus one repair at worst (the check's 240 s budget and the model's turns). */
const CHECK_ROUND_MS = 4 * 60_000;
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
  return Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX_WORKER_SANDBOXES;
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

const skipReason = (error: unknown) =>
  error instanceof RateLimitError ? "E2B rate limit" : error instanceof Error ? error.message : "unknown error";

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
    const { snapshotId } = await sandbox.createSnapshot({ requestTimeoutMs: CALL_TIMEOUT_MS });
    await convex.mutation(api.agentTasks.setSeedSnapshot, { internalKey, messageId, snapshotId });
    return snapshotId;
  } catch (error) {
    // A failed install is the integration build's to report.
    if (!(error instanceof CommandExitError)) console.error("[swarm-sandbox] foundation failed", projectId, error);
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
  internalKey, projectId, messageId, agentTaskId, invokedAt,
}: {
  internalKey: string; projectId: Id<"projects">; messageId: Id<"messages">; agentTaskId: Id<"agentTasks">;
  invokedAt: number;
}): Promise<StartResult> => {
  const apiKey = e2bKey();
  if (!apiKey) return { off: true };
  // The worker's writes are already in Convex: never let the check run it past its timeout.
  const rounds = Math.floor((invokedAt + WORKER_TIMEOUT_MS - Date.now()) / CHECK_ROUND_MS);
  if (rounds < 1) return { skipped: "time budget" };
  // shortcut: verifyAndFix always allows one repair, so with 4-8 min left a slow one can still overrun.
  const maxAttempts = Math.min(SELF_CHECK_ATTEMPTS, Math.max(1, rounds - 1));
  let sandbox: Sandbox | undefined;
  try {
    const budget = await overBudget(apiKey);
    if (budget) return { skipped: budget };
    const claim = await convex.mutation(api.agentTasks.claimSelfCheck, {
      internalKey, agentTaskId, max: maxWorkerSandboxes(),
    });
    if (claim.skipped !== undefined) return { skipped: claim.skipped };
    sandbox = await createSwarmSandbox(
      apiKey, claim.seedSnapshotId, { projectId, messageId, purpose: "swarm-worker" }, WORKER_SANDBOX_TIMEOUT_MS,
    );
    // shortcut: files deleted since the snapshot stay in the sandbox; rare within one swarm.
    await writeProjectFiles(sandbox, await projectTextFiles(internalKey, projectId));
    return { sandboxId: sandbox.sandboxId, maxAttempts };
  } catch (error) {
    await sandbox?.kill().catch(() => {});
    return { skipped: skipReason(error) };
  }
};

/**
 * Connects only when verifyAndFix first touches the sandbox, so a replay whose
 * check steps are memoized never reconnects to (or revives) a killed one.
 */
const lazySandbox = (sandboxId: string, apiKey: string) => {
  let connected: Promise<Sandbox> | undefined;
  const part = (name: "commands" | "files") => new Proxy({}, {
    get: (_, method: string) => async (...args: unknown[]) => {
      const sandbox = await (connected ??= Sandbox.connect(sandboxId, { apiKey }));
      const target = sandbox[name] as unknown as Record<string, (...a: unknown[]) => unknown>;
      return target[method](...args);
    },
  });
  return { sandboxId, commands: part("commands"), files: part("files") } as unknown as Sandbox;
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
  ...(event.status === "error" ? { error: event.reason ?? `${event.errors?.length ?? 0} build error(s)` } : {}),
  startedAt: now,
  ...(event.status === "running" ? {} : { endedAt: now }),
});

type Step = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };

/**
 * A worker's self-check, called from the swarm-worker function body (never
 * inside step.run) after its network ends. Null while the switch is off;
 * skipped unless the snapshot is ready, a swarm slot is free and the team
 * budget allows it.
 */
export const selfCheckWorker = async ({
  step, internalKey, projectId, messageId, agentTaskId, ownedPaths, invokedAt, model, onEvent,
}: {
  step: Step;
  internalKey: string;
  projectId: Id<"projects">;
  messageId: Id<"messages">;
  agentTaskId: Id<"agentTasks">;
  ownedPaths: string[];
  /** When step.invoke started the worker's WORKER_TIMEOUT_MS. */
  invokedAt: number;
  model: VerifyAndFixOptions["model"];
  onEvent: (event: RepairEvent) => Promise<void>;
}): Promise<SelfCheck | null> => {
  const started = (await step.run("self-check-start", () =>
    startWorkerSandbox({ internalKey, projectId, messageId, agentTaskId, invokedAt }))) as StartResult;
  if ("off" in started) return null;
  if ("skipped" in started) return { selfCheck: `skipped (${started.skipped})`, filesChanged: [] };

  const owns = (path: string) => ownsPath(ownedPaths, path);
  const result = await verifyAndFix({
    sandbox: lazySandbox(started.sandboxId, process.env.E2B_API_KEY?.trim() ?? ""),
    projectId,
    internalKey,
    runId: messageId,
    agentTaskId,
    model,
    maxAttempts: started.maxAttempts,
    filterErrors: ownedErrors(ownedPaths),
    allowedPaths: owns,
    onEvent,
    step: (id, fn) => step.run(id, fn),
  });
  await step.run("self-check-stop", async () => {
    await Sandbox.kill(started.sandboxId, { apiKey: process.env.E2B_API_KEY?.trim() }).catch(() => false);
  });
  const ownedLeft = ownedErrors(ownedPaths)(result.errors).length;
  // A full pass of a partial tree proves only this worker's files: still scoped.
  const selfCheck = result.status === "verified" || result.status === "scoped-ok"
    ? "scoped-ok"
    : result.status === "failed"
      ? `scoped-failed (${ownedLeft} in owned files)`
      : `skipped (${result.reason ?? "unverified"})`;
  return { selfCheck, filesChanged: result.filesChanged };
};
