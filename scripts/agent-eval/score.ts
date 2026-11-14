import { missingReferencedFiles, undeclaredPackages, unresolvedImports } from "../../src/features/sandbox-preview/utils/missing-references";
import { totalUsd } from "./cost";
import type { Trail } from "./types";

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
    id: trail.id, model: trail.model, prompt: trail.prompt, projectId: trail.projectId,
    completed: Boolean(final && final.status === "completed" && final.runModel?.modelId === trail.model && final.content !== FAILURE && !final.stuck && !trail.capped && !trail.error),
    capped: trail.capped, error: trail.error, finalStatus: final?.status, stuck: final?.stuck,
    checkBuild: checks, toolErrorCount: toolErrors.length, toolErrors,
    modelCallsApprox, iterationCapHit: assistants.some((m) => new Set((m.steps ?? []).map((s) => s.startedAt)).size >= 39 || /Step budget reached/.test(m.content)),
    missingReferencedFiles: missingReferencedFiles(files), undeclaredPackages: undeclaredPackages(files), unresolvedImports: unresolvedImports(files),
    preview: trail.preview, consoleErrors: trail.consoleErrors,
    sandboxErrors: trail.sandboxEvents.filter((e) => e.type === "error"),
    autoFixCount: trail.messages.filter((m) => m.role === "user" && m.content.startsWith("The preview shows a")).length,
    autoFixOutcomes: assistants.slice(1).map((m) => ({ status: m.status, stuck: m.stuck })),
    firstPreviewMs: trail.firstPreviewAt ? trail.firstPreviewAt - trail.startedAt : null,
    wallMs: trail.endedAt - trail.startedAt, tokensIn, tokensOut, usd: totalUsd(trail.usage),
    // creditLedger.costUsd is authoritative: rows sum a run's calls, so the
    // per-prompt >100K price tier cannot be re-derived from them.
    usageRecorded: assistants.length > 0 && assistants.every((m) => trail.usage.some((r) => r.messageId === m._id)),
  };
}

export type Score = ReturnType<typeof score>;
