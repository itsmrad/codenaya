import { ICodebaseFileSystem } from "../codebase/file-system";
import { TesterSubagent } from "../subagents/tester";
import { AcceptanceCriterion, ValidationResult } from "../types";

/**
 * Phase 7: Test & Validate
 * Runs tests, acceptance criteria checks, and structural validation on the updated codebase.
 */
export async function runValidation(
  fileSystem: ICodebaseFileSystem,
  acceptanceCriteria?: AcceptanceCriterion[]
): Promise<ValidationResult> {
  const tester = new TesterSubagent();

  const result = await tester.execute("Validate codebase structural integrity and criteria", {
    taskId: "validate-" + Date.now(),
    role: "tester",
    complexity: "low",
    modelSelection: {
      provider: "mock",
      modelId: "tester-model",
      tier: "fast",
      reason: "Validation check",
    },
    fileSystem,
    metadata: {
      acceptanceCriteria: acceptanceCriteria ?? [],
    },
  });

  const validationResult = result.data?.validationResult as ValidationResult | undefined;

  if (!validationResult) {
    return {
      passed: result.success,
      checks: [],
      errors: result.error ? [result.error] : [],
      warnings: [],
    };
  }

  return validationResult;
}
