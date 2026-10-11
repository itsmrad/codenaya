import { ValidationResult, ReviewResult } from "../types";
import { RegressionAnalysis } from "./types";

/**
 * Regression Analyzer.
 *
 * Implements the required regression loop:
 * REJECT CHANGE → ROLLBACK → ANALYZE → CREATE ALTERNATIVE → TEST AGAIN
 */
export class RegressionAnalyzer {
  /**
   * Analyzes test validation or senior review failures and produces a structured diagnosis
   * with alternative hypotheses for the subsequent retry.
   */
  public analyzeFailure(params: {
    experimentDescription: string;
    targetFiles: string[];
    validation?: ValidationResult;
    review?: ReviewResult;
    previousBestScore?: number;
    customError?: string;
  }): RegressionAnalysis {
    const {
      experimentDescription,
      targetFiles,
      validation,
      review,
      previousBestScore,
      customError,
    } = params;

    let failureType: RegressionAnalysis["failureType"] = "validation";
    const rootCauses: string[] = [];
    const regressedFiles: Set<string> = new Set(targetFiles);

    // 1. Check for syntax / structural validation regressions
    if (validation && !validation.passed) {
      if (validation.errors.some((e) => e.includes("brace") || e.includes("syntax") || e.includes("JSON"))) {
        failureType = "syntax";
      } else {
        failureType = "validation";
      }

      for (const err of validation.errors) {
        rootCauses.push(err);
      }

      for (const check of validation.checks) {
        if (check.status === "failed") {
          rootCauses.push(`${check.name}: ${check.message}`);
          if (check.filePath) regressedFiles.add(check.filePath);
        }
      }
    }

    // 2. Check for review score regressions or critical findings
    if (review) {
      const criticalFindings = review.findings.filter((f) => f.severity === "critical");
      if (criticalFindings.length > 0) {
        failureType = "criteria-failure";
        for (const cf of criticalFindings) {
          rootCauses.push(`Critical Review Finding: ${cf.title} - ${cf.description}`);
          if (cf.filePath) regressedFiles.add(cf.filePath);
        }
      }

      if (previousBestScore !== undefined && review.score < previousBestScore) {
        failureType = "score-drop";
        rootCauses.push(
          `Quality score regressed from previous best of ${previousBestScore}/100 down to ${review.score}/100.`
        );
      }
    }

    // 3. Custom error (e.g. unauthorized file access)
    if (customError) {
      if (customError.includes("Safety Violation") || customError.includes("user work")) {
        failureType = "unauthorized-file-access";
      }
      rootCauses.push(customError);
    }

    const primaryCause =
      rootCauses.length > 0
        ? rootCauses.slice(0, 3).join("; ")
        : `Experiment failed quality thresholds for "${experimentDescription}".`;

    // Formulate actionable alternative implementation strategy
    const proposedAlternative = this.formulateAlternative(
      failureType,
      experimentDescription,
      Array.from(regressedFiles)
    );

    const nextSteps = [
      "Confirm rollback has restored the verified best state with no leftover experimental files.",
      `Apply alternative design strategy: ${proposedAlternative}`,
      "Execute targeted isolated test check on the revised implementation.",
      "Verify structural integrity before promoting to best version.",
    ];

    return {
      detectedAt: Date.now(),
      failureType,
      rootCause: primaryCause,
      regressedFiles: Array.from(regressedFiles),
      impactScore: review?.score,
      proposedAlternative,
      nextSteps,
    };
  }

  private formulateAlternative(
    type: RegressionAnalysis["failureType"],
    goal: string,
    files: string[]
  ): string {
    switch (type) {
      case "syntax":
        return `Implement "${goal}" with strict AST validation and bracket balancing in ${files.slice(0, 2).join(", ") || "target files"}.`;
      case "unauthorized-file-access":
        return `Isolate implementation of "${goal}" strictly inside newly created modular files rather than touching pre-existing user files.`;
      case "score-drop":
        return `Implement minimal incremental delta for "${goal}", preserving all existing function signatures and exports.`;
      case "criteria-failure":
        return `Address unmet criteria directly by providing explicit interface definitions and verifying individual acceptance tests.`;
      case "validation":
      default:
        return `Refactor implementation of "${goal}" into self-contained units with mock fallbacks to avoid import or resolution breakage.`;
    }
  }
}

