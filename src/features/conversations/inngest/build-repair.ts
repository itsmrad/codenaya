import { Sandbox } from "e2b";

import {
  type AgentStep,
  BUILD_CHECK_UNFINISHED,
  BUILD_NOT_CHECKED,
  BUILD_VERIFIED,
  STATIC_CHECKS_FAILED,
  buildPathIndex,
  clampStepText,
} from "@/features/conversations/agent-steps";
import {
  type RepairEvent,
  type RepairResult,
  type VerifyAndFixOptions,
  verifyAndFix,
} from "@/features/conversations/server/sandbox-repair";
import {
  DEFAULT_INSTALL_COMMAND,
  type ProjectFile,
  WORK_DIR,
  createProjectSandbox,
  writeProjectFiles,
} from "@/features/sandbox-preview/server/project-sandbox";
import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import { BUILD_FAILED_NOTE, BUILD_REPAIRED_NOTE, BUILD_UNVERIFIED_NOTE } from "./build-check-gate";
import { isSafeProjectPath, projectFramework } from "./tools/check-build";

/**
 * The chat run's build repair after its own turns: when the run's changes
 * ended on a failed check (or none), `verifyAndFix` checks and repairs them in
 * a new sandbox before the run completes, so the fix needs no open tab.
 *
 * Always a new sandbox, never the user's preview: the repair spans many
 * steps and writes into its sandbox, and the preview may be stale (tab
 * closed), killed on reopen (#492) or hold the project's `.env`.
 */

/**
 * Repairs after the first check, each followed by a fresh check. With a
 * `fallbackModel`, these run on the cheap model, and one more on the fallback.
 */
export const MAX_SERVER_REPAIRS = 2;
/** Renewed by each connect; E2B reaps it after this if every kill is lost. */
const REPAIR_SANDBOX_TIMEOUT_MS = 10 * 60_000;
/**
 * The warm-up install's own budget. Each check installs again, from scratch,
 * within its 180 s; with the npm cache warm that is mostly linking.
 */
const INSTALL_TIMEOUT_MS = 240_000;
const UPLOAD_TIMEOUT_MS = 10_000;
/** Sandbox metadata, with the run's id, so the run's sandboxes can be found to stop. */
const REPAIR_PURPOSE = "build-repair";

/**
 * Stops every repair sandbox `runId` started: a retried provisioning step can
 * have started more than one. Also run when the run fails or is cancelled
 * (`stop-repair-sandboxes.ts`), which skips the run's own kill step.
 */
export const killRepairSandboxes = async (runId: string) => {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) return;
  const running = await Sandbox.list({
    apiKey,
    query: { metadata: { purpose: REPAIR_PURPOSE, runId }, state: ["running"] },
  }).nextItems();
  await Promise.all(running.map(({ sandboxId }) => Sandbox.kill(sandboxId, { apiKey })));
};

/**
 * The project from Convex, in a new sandbox: returns its id, or null for a
 * project the check does not build. Uploads too, so imports of them resolve.
 */
const provision = async (
  apiKey: string,
  { projectId, internalKey, runId }: Pick<VerifyAndFixOptions, "projectId" | "internalKey" | "runId">,
) => {
  const rows = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
  const pathOf = buildPathIndex(rows);
  const files: ProjectFile[] = [];
  const uploads: Array<{ path: string; url: string }> = [];
  for (const row of rows) {
    const path = row.type === "file" ? pathOf(row._id) : undefined;
    if (!path || !isSafeProjectPath(path)) continue;
    if (typeof row.content === "string") files.push({ path, content: row.content });
    else if (row.storageUrl) uploads.push({ path, url: row.storageUrl });
  }
  // Any other project could never verify, so a repair would only spend.
  if (!projectFramework(files, [...files, ...uploads].map(({ path }) => path))) return null;
  const sandbox = await createProjectSandbox({
    apiKey,
    timeoutMs: REPAIR_SANDBOX_TIMEOUT_MS,
    metadata: { projectId, runId, purpose: REPAIR_PURPOSE },
  });
  try {
    await writeProjectFiles(sandbox, files);
    for (const { path, url } of uploads) {
      const response = await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Could not read upload ${path} (${response.status})`);
      await sandbox.files.write(`${WORK_DIR}/${path}`, await response.arrayBuffer());
    }
  } catch (error) {
    await sandbox.kill().catch(() => {}); // Best effort: E2B reaps it anyway.
    throw error;
  }
  return sandbox.sandboxId;
};

const checkError = ({ errors = [], reason }: RepairEvent) =>
  reason
    ? reason.startsWith("Error:") ? reason : `${BUILD_CHECK_UNFINISHED} (${reason})`
    : clampStepText(
        `${errors[0]?.kind === "static" ? STATIC_CHECKS_FAILED : "Error: Build failed"}: ` +
          errors.map(({ file, message }) => (file ? `${file}: ${message}` : message)).join("; "),
      );

/**
 * The run block's rows for a repair event: checks as checkBuild rows, a
 * repair as its note and, once done, its writes as an editFile row, so the
 * run's diff and revert include them (#225).
 */
export const repairSteps = (event: RepairEvent, now = Date.now()): AgentStep[] => {
  const { id, phase, attempt, status, reason, filesChanged = [] } = event;
  if (phase === "verify") {
    if (status === "running") return [{ id, kind: "tool", tool: "checkBuild", status, startedAt: now }];
    // A project this check cannot build is not an error, as with the checkBuild tool.
    if (status === "done" || reason === BUILD_NOT_CHECKED) {
      return [{ id, kind: "tool", tool: "checkBuild", status: "done", text: status === "done" ? BUILD_VERIFIED : reason, startedAt: now, endedAt: now }];
    }
    return [{ id, kind: "tool", tool: "checkBuild", status: "error", error: checkError(event), startedAt: now, endedAt: now }];
  }
  if (status === "running") {
    return [{
      id,
      kind: "thinking",
      text: `The build check failed, so the agent is fixing it (attempt ${attempt}).`,
      status: "done",
      startedAt: now,
    }];
  }
  return filesChanged.length > 0
    ? [{ id: `${id}:files`, kind: "tool", tool: "editFile", targets: filesChanged, status: "done", startedAt: now, endedAt: now }]
    : [];
};

/** Whether the run's build ends verified, and the note its reply gets, after a repair. */
export const repairOutcome = (repair: RepairResult, noteBefore: string | undefined) => {
  if (repair.ok) return { verified: true, note: BUILD_REPAIRED_NOTE };
  if (repair.status === "failed") return { verified: false, note: BUILD_FAILED_NOTE };
  // Not checked again: the run's own note holds unless the repair changed files.
  return { verified: false, note: repair.filesChanged.length > 0 ? BUILD_UNVERIFIED_NOTE : noteBefore };
};

/**
 * Checks and repairs the project in a new sandbox, each part a durable step.
 * Null when there is no build sandbox to use. Never throws.
 */
export const repairBuild = async ({
  step,
  recordSteps,
  fallbackModel,
  ...options
}: Pick<VerifyAndFixOptions, "projectId" | "internalKey" | "runId" | "model" | "onResponse" | "signal"> & {
  /** Takes over once the repairs on `model` (a cheap one) fail or change nothing. */
  fallbackModel?: VerifyAndFixOptions["model"];
  step: NonNullable<VerifyAndFixOptions["step"]>;
  /** Upserts the rows `build` returns into the run block, in a step. */
  recordSteps: (build: () => AgentStep[]) => Promise<void>;
}): Promise<RepairResult | null> => {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) return null;

  const sandboxId = (await step("provision-repair-sandbox", async () => {
    try {
      return await provision(apiKey, options);
    } catch (error) {
      console.error("[build-repair] could not start the repair sandbox", error);
      return null;
    }
  })) as string | null;
  if (!sandboxId) return null;

  let connected: Promise<Sandbox> | undefined;
  const sandbox = () =>
    (connected ??= Sandbox.connect(sandboxId, { apiKey, timeoutMs: REPAIR_SANDBOX_TIMEOUT_MS }));

  // Fills the npm cache, so the checks' own installs fit their budget.
  await step("install-repair-sandbox", async () => {
    try {
      await (await sandbox()).commands.run(DEFAULT_INSTALL_COMMAND, {
        cwd: WORK_DIR,
        timeoutMs: INSTALL_TIMEOUT_MS,
        requestTimeoutMs: INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      // The first check installs again and reports what failed.
      console.error("[build-repair] warm-up install failed", error instanceof Error ? error.message : error);
    }
    return null;
  });

  const result = await verifyAndFix({
    ...options,
    sandbox,
    ...(fallbackModel
      ? { fallback: { model: fallbackModel, after: MAX_SERVER_REPAIRS }, maxAttempts: MAX_SERVER_REPAIRS + 1 }
      : { maxAttempts: MAX_SERVER_REPAIRS }),
    step,
    onEvent: (event) => recordSteps(() => repairSteps(event)),
  });

  await step("kill-repair-sandbox", async () => {
    await killRepairSandboxes(options.runId).catch(async (error) => {
      console.error("[build-repair] could not stop the repair sandboxes", error);
      // At least the one this run knows; best effort, E2B reaps it anyway.
      await Sandbox.kill(sandboxId, { apiKey }).catch(() => {});
    });
    return null;
  });
  return result;
};
