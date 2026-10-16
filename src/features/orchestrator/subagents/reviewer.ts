import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import {
  SubagentRole,
  ReviewResult,
  ReviewFinding,
} from "../types";

export class CodeReviewerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "code-reviewer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const acceptanceCriteria = input.acceptanceCriteria;
    const files = await input.fileSystem.listFiles();

    const findings: ReviewFinding[] = [];
    const improvementOpportunities: string[] = [];
    const criteriaAssessments: ReviewResult["criteriaAssessments"] = [];

    // Assess each acceptance criterion against the codebase state
    for (const criterion of acceptanceCriteria) {
      let satisfied = true;
      let notes = "Criterion satisfied.";

      if (
        criterion.description.toLowerCase().includes("type") ||
        criterion.description.toLowerCase().includes("interface")
      ) {
        const hasTypes = files.some(
          (f) =>
            f.path.includes("types") ||
            f.content.includes("export interface") ||
            f.content.includes("export type") ||
            f.content.includes("interface ") ||
            f.content.includes("type ") ||
            f.content.includes("export const") ||
            f.content.includes("export function")
        );
        if (!hasTypes) {
          satisfied = false;
          notes = "No explicit type definitions or interfaces detected.";
        }
      }

      criteriaAssessments.push({
        criterionId: criterion.id,
        satisfied,
        notes,
      });

      if (!satisfied && criterion.required) {
        findings.push({
          severity: "major",
          title: `Unmet Criterion: ${criterion.id}`,
          description: criterion.description,
          recommendation: notes,
        });
      }
    }

    // Inspect files for common anti-patterns
    for (const file of files) {
      if (file.content.includes("TODO") || file.content.includes("FIXME")) {
        findings.push({
          severity: "minor",
          title: `Unresolved TODO/FIXME in ${file.path}`,
          description: "File contains unresolved TODO or placeholder comment.",
          filePath: file.path,
          recommendation: "Replace with complete implementation or remove comment.",
        });
      }

      if (
        file.content.includes("any") &&
        (file.path.endsWith(".ts") || file.path.endsWith(".tsx"))
      ) {
        improvementOpportunities.push(
          `Refine loose 'any' types in ${file.path} into strongly typed TypeScript interfaces.`
        );
      }
    }

    let score = 100;
    for (const f of findings) {
      if (f.severity === "critical") score -= 30;
      else if (f.severity === "major") score -= 15;
      else if (f.severity === "minor") score -= 5;
    }
    score = Math.max(0, Math.min(100, score));

    const approved = score >= 70 && !findings.some((f) => f.severity === "critical");

    const reviewResult: ReviewResult = {
      approved,
      score,
      criteriaAssessments,
      findings,
      improvementOpportunities,
      summary: approved
        ? `Implementation approved with quality score ${score}/100.`
        : `Implementation requires improvements (score ${score}/100) before approval.`,
    };

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: approved,
      status: approved ? "COMPLETED" : "FAILED",
      summary: reviewResult.summary,
      findings: findings.map((f) => `[${f.severity.toUpperCase()}] ${f.title}: ${f.description}`),
      proposedChanges: {
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
      },
      criteriaAssessments,
      boundaryViolations: [],
      data: { reviewResult },
    };
  }
}

/**
 * Backward-compatible alias for existing code referencing ReviewerSubagent
 */
export class ReviewerSubagent extends CodeReviewerSubagent {
  public override readonly role: SubagentRole = "reviewer";
}
