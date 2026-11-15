import { missingReferencedFiles, undeclaredPackages, unresolvedImports } from "../../src/features/sandbox-preview/utils/missing-references";
import { isHmrNoise, isRuntimeError } from "./capture";
import { totalUsd } from "./cost";
import type { Trail } from "./types";

/** Swarm shape from agentTasks rows: a sub-orchestrator's worker is `<parent>/<child>`, so depth is the id's segment count. */
export function swarmStats(trail: Trail) {
  const orchestrator = trail.messages.find((m) => m.role === "assistant" && m.steps?.some((s) => s.tool === "delegateTasks" && s.status === "done"));
  const delegatedAt = orchestrator?.steps?.find((s) => s.tool === "delegateTasks" && s.status === "done")?.startedAt;
  const selfCheck = (value?: string) => !value ? "none" : value === "scoped-ok" ? "ok" : value.startsWith("scoped-failed") ? "failed" : value.startsWith("skipped") ? "skipped" : value;
  return {
    tasksPlanned: trail.tasks.filter((t) => !t.parentTaskId).length,
    workers: trail.tasks.filter((t) => t.role === "worker").length,
    failed: trail.tasks.filter((t) => t.status === "error").length,
    unfinished: trail.tasks.filter((t) => t.status === "queued" || t.status === "running").length,
    maxDepth: Math.max(0, ...trail.tasks.map((t) => t.taskId.split("/").length)),
    integratorTurns: delegatedAt === undefined ? null : new Set(orchestrator!.steps!.filter((s) => s.startedAt > delegatedAt).map((s) => s.startedAt)).size,
    selfChecks: trail.tasks.filter((t) => t.role === "worker").map((t) => ({ taskId: t.taskId, status: t.status, selfCheck: selfCheck(t.selfCheck) })),
  };
}

const FAILURE = "My apologies, I encountered an error while processing your request. Let me know if you need anything else!";
export function score(trail: Trail, files: { path: string; content: string }[]) {
  const assistants = trail.messages.filter((m) => m.role === "assistant");
  const final = assistants.at(-1);
  const steps = assistants.flatMap((m) => m.steps ?? []);
  const modelCallsApprox = assistants.reduce((sum, m) => sum + new Set((m.steps ?? []).map((s) => s.startedAt)).size, 0);
  const toolErrors = steps.filter((s) => s.kind === "tool" && s.status === "error");
  const checks = steps.filter((s) => s.tool === "checkBuild").map((s) => ({ status: s.status, text: s.text, error: s.error, passed: s.status === "done" && /Build verified|Static checks passed/.test(s.text ?? "") }));
  const tokensIn = trail.usage.reduce((sum, r) => sum + r.inputTokens, 0);
  const tokensOut = trail.usage.reduce((sum, r) => sum + r.outputTokens, 0);
  return {
    id: trail.id, model: trail.model, mode: trail.mode, prompt: trail.prompt, projectId: trail.projectId,
    completed: Boolean(final && final.status === "completed" && final.runModel?.modelId === trail.model && final.content !== FAILURE && !final.stuck && !trail.capped && !trail.error),
    capped: trail.capped, error: trail.error, finalStatus: final?.status, stuck: final?.stuck,
    checkBuild: checks, toolErrorCount: toolErrors.length, toolErrors,
    modelCallsApprox, iterationCapHit: assistants.some((m) => new Set((m.steps ?? []).map((s) => s.startedAt)).size >= 39 || /Step budget reached/.test(m.content)),
    missingReferencedFiles: missingReferencedFiles(files), undeclaredPackages: undeclaredPackages(files), unresolvedImports: unresolvedImports(files),
    preview: trail.preview, consoleErrors: trail.consoleErrors.filter((e) => !isHmrNoise(e.text)),
    previewOk: trail.preview.loaded && !trail.preview.overlay && !(trail.preview.errors ?? []).some(isRuntimeError),
    sandboxErrors: trail.sandboxEvents.filter((e) => e.type === "error"),
    autoFixCount: trail.messages.filter((m) => m.role === "user" && m.content.startsWith("The preview shows a")).length,
    autoFixOutcomes: assistants.slice(1).map((m) => ({ status: m.status, stuck: m.stuck })),
    firstPreviewMs: trail.firstPreviewAt ? trail.firstPreviewAt - trail.startedAt : null,
    firstAppPaintMs: trail.firstAppPaintAt ? trail.firstAppPaintAt - trail.startedAt : null,
    messageMs: assistants[0]?.completedAt ? assistants[0].completedAt - trail.startedAt : null,
    swarm: trail.mode === "swarm" ? swarmStats(trail) : null,
    wallMs: trail.endedAt - trail.startedAt, tokensIn, tokensOut, usd: totalUsd(trail.usage),
    // creditLedger.costUsd is authoritative: rows sum a run's calls, so the
    // per-prompt >100K price tier cannot be re-derived from them.
    usageRecorded: assistants.length > 0 && assistants.every((m) => trail.usage.some((r) => r.messageId === m._id)),
  };
}

export type Score = ReturnType<typeof score>;
