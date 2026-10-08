import {
  CodebaseInspection,
  FinalReport,
  ImplementationPlan,
  ImplementationResult,
  ReviewResult,
  ValidationResult,
} from "../types";
import { TrackedRequirement } from "../requirements/types";
import { OptimizationExperiment } from "../experiments/types";

export interface GenerateReportParams {
  taskId: string;
  goal: string;
  inspection: CodebaseInspection;
  plan: ImplementationPlan;
  implementation: ImplementationResult;
  validation: ValidationResult;
  review: ReviewResult;
  trackedRequirements?: TrackedRequirement[];
  experiments?: OptimizationExperiment[];
}

/**
 * Phase 9: Report
 * Synthesizes a concise executive final report detailing the outcome, decisions made,
 * and verification state.
 */
export function generateFinalReport(params: GenerateReportParams): FinalReport {
  const {
    taskId,
    goal,
    inspection,
    plan,
    implementation,
    validation,
    review,
    trackedRequirements,
  } = params;

  const passedCriteriaCount = review.criteriaAssessments.filter(
    (c) => c.satisfied
  ).length;

  const headline = review.approved
    ? `Task Successfully Completed: ${goal}`
    : `Task Completed with Advisories: ${goal}`;

  const executiveSummary = [
    `Senior Lead Orchestrator coordinated ${plan.subtasks.length} subtasks to fulfill: "${goal}".`,
    `Base architecture detected as ${inspection.framework} with ${inspection.styling}.`,
    `${implementation.filesCreated.length} files created, ${implementation.filesModified.length} modified, ${implementation.filesDeleted.length} deleted.`,
    `Validation status: ${validation.passed ? "PASSED" : "FAILED"} (${validation.checks.length} checks executed).`,
    `Review score: ${review.score}/100 (${review.approved ? "APPROVED" : "ATTENTION REQUIRED"}).`,
  ].join(" ");

  const architecturalDecisions = [
    `Preserved existing ${inspection.framework} project boundaries and conventions.`,
    `Structured implementation into ${plan.subtasks.length} dependency-aware subtasks to maximize concurrency.`,
    ...plan.architecturalNotes,
  ];

  return {
    taskId,
    headline,
    executiveSummary,
    architecturalDecisions,
    filesCreated: implementation.filesCreated,
    filesModified: implementation.filesModified,
    filesDeleted: implementation.filesDeleted,
    acceptanceCriteriaStatus: {
      total: plan.acceptanceCriteria.length,
      passed: passedCriteriaCount,
      failed: plan.acceptanceCriteria.length - passedCriteriaCount,
    },
    requirementsStatus: trackedRequirements
      ? {
          total: trackedRequirements.length,
          verified: trackedRequirements.filter((r) => r.status === "VERIFIED").length,
          pending: trackedRequirements.filter((r) => r.status === "PENDING").length,
          failed: trackedRequirements.filter((r) => r.status === "FAILED").length,
          blocked: trackedRequirements.filter((r) => r.status === "BLOCKED").length,
          allVerified:
            trackedRequirements.length > 0 &&
            trackedRequirements.every((r) => r.status === "VERIFIED"),
        }
      : undefined,
    experimentsStatus: params.experiments
      ? {
          total: params.experiments.length,
          accepted: params.experiments.filter((e) => e.decision === "ACCEPT").length,
          rejected: params.experiments.filter((e) => e.decision === "REJECT").length,
          abandoned: params.experiments.filter((e) => e.decision === "ABANDON").length,
          bestScore: params.experiments.reduce(
            (max, e) => (e.result?.score && e.result.score > max ? e.result.score : max),
            review.score
          ),
        }
      : undefined,
    validationSummary: {
      passed: validation.passed,
      checksCount: validation.checks.length,
      warningsCount: validation.warnings.length,
    },
    reviewVerdict: {
      approved: review.approved,
      score: review.score,
      findingsCount: review.findings.length,
    },
    improvementOpportunities: review.improvementOpportunities ?? [],
    toRun: {
      install: inspection.packageDependencies ? "npm install" : undefined,
      dev: inspection.framework === "vite" ? "npm run dev" : "npm run dev",
      test: "npm test",
    },
  };
}
