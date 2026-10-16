import { ICodebaseFileSystem } from "../codebase/file-system";
import { ReviewerSubagent } from "../subagents/reviewer";
import { ImplementationPlan, ReviewResult } from "../types";

/**
 * Phase 8: Review & Evaluate
 * Performs a senior engineering lead code review against the plan's acceptance criteria.
 * Identifies defects, deviations, and improvement opportunities.
 */
export async function runReview(
  plan: ImplementationPlan,
  fileSystem: ICodebaseFileSystem
): Promise<ReviewResult> {
  const reviewer = new ReviewerSubagent();

  const result = await reviewer.execute("Senior lead review against criteria", {
    taskId: "review-" + Date.now(),
    role: "reviewer",
    complexity: "medium",
    modelSelection: {
      provider: "mock",
      modelId: "reviewer-model",
      tier: "advanced",
      reason: "Engineering review",
    },
    fileSystem,
    metadata: {
      acceptanceCriteria: plan.acceptanceCriteria,
    },
  });

  const reviewResult = result.data?.reviewResult as ReviewResult | undefined;

  if (!reviewResult) {
    return {
      approved: result.success,
      score: result.success ? 85 : 50,
      criteriaAssessments: plan.acceptanceCriteria.map((c) => ({
        criterionId: c.id,
        satisfied: result.success,
        notes: result.summary,
      })),
      findings: [],
      improvementOpportunities: [],
      summary: result.summary,
    };
  }

  return reviewResult;
}
