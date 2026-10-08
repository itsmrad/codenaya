import { ICodebaseFileSystem } from "../codebase/file-system";
import {
  ImplementationPlan,
  ImplementationResult,
  ModelSelection,
  SubagentRole,
  Subtask,
} from "../types";
import { ISubagent, SubagentTaskInput } from "../subagents/base";
import { SubagentRegistry } from "../subagents/registry";
import { buildExecutionBatches } from "./5-delegate";

export type { ImplementationResult };

export class ImplementationCoordinator {
  private registry: SubagentRegistry;

  constructor(customRegistry?: SubagentRegistry | Map<SubagentRole, ISubagent>) {
    if (customRegistry instanceof SubagentRegistry) {
      this.registry = customRegistry;
    } else if (customRegistry instanceof Map) {
      this.registry = new SubagentRegistry(customRegistry);
    } else {
      this.registry = new SubagentRegistry();
    }
  }

  async executePlan(
    plan: ImplementationPlan,
    modelAssignments: Map<string, ModelSelection>,
    fileSystem: ICodebaseFileSystem,
    onSubtaskProgress?: (subtask: Subtask) => void,
    contextManager?: unknown
  ): Promise<ImplementationResult> {
    void contextManager;
    const batches = buildExecutionBatches(plan);
    const completedSubtasks: Subtask[] = [];
    const filesCreated = new Set<string>();
    const filesModified = new Set<string>();
    const filesDeleted = new Set<string>();
    const errors: string[] = [];
    const rejections: string[] = [];

    // Map to track files modified across the execution session for conflict resolution
    const sessionModifiedFiles = new Map<string, string>(); // path -> subtaskId

    for (const batch of batches) {
      if (batch.mode === "parallel") {
        const results = await Promise.all(
          batch.subtasks.map((st) =>
            this.runSubtask(st, plan, modelAssignments, fileSystem, sessionModifiedFiles)
          )
        );

        for (const res of results) {
          completedSubtasks.push(res);
          onSubtaskProgress?.(res);
          if (res.result) {
            res.result.filesCreated.forEach((f) => filesCreated.add(f));
            res.result.filesModified.forEach((f) => filesModified.add(f));
            res.result.filesDeleted.forEach((f) => filesDeleted.add(f));
            if (res.result.error) errors.push(res.result.error);
          }
          if (res.status === "REJECTED" && res.rejectionReason) {
            rejections.push(`[${res.id}] Rejected: ${res.rejectionReason}`);
          }
        }
      } else {
        for (const st of batch.subtasks) {
          const res = await this.runSubtask(
            st,
            plan,
            modelAssignments,
            fileSystem,
            sessionModifiedFiles
          );
          completedSubtasks.push(res);
          onSubtaskProgress?.(res);
          if (res.result) {
            res.result.filesCreated.forEach((f) => filesCreated.add(f));
            res.result.filesModified.forEach((f) => filesModified.add(f));
            res.result.filesDeleted.forEach((f) => filesDeleted.add(f));
            if (res.result.error) errors.push(res.result.error);
          }
          if (res.status === "REJECTED" && res.rejectionReason) {
            rejections.push(`[${res.id}] Rejected: ${res.rejectionReason}`);
          }
        }
      }
    }

    return {
      completedSubtasks,
      filesCreated: Array.from(filesCreated),
      filesModified: Array.from(filesModified),
      filesDeleted: Array.from(filesDeleted),
      success: errors.length === 0,
      errors,
      rejections,
    };
  }

  private async runSubtask(
    subtask: Subtask,
    plan: ImplementationPlan,
    modelAssignments: Map<string, ModelSelection>,
    fileSystem: ICodebaseFileSystem,
    sessionModifiedFiles: Map<string, string>
  ): Promise<Subtask> {
    const subagent = this.registry.getAgent(subtask.role);
    if (!subagent) {
      return {
        ...subtask,
        status: "FAILED",
        result: {
          filesModified: [],
          filesCreated: [],
          filesDeleted: [],
          summary: `Missing specialized subagent for role '${subtask.role}'`,
          error: `No subagent registered for role '${subtask.role}'`,
        },
      };
    }

    const modelSelection: ModelSelection = modelAssignments.get(subtask.id) ?? {
      provider: "mock",
      modelId: "default-model",
      tier: subtask.recommendedModelTier ?? "standard",
      reason: "Fallback model",
      expectedOutput: subtask.expectedOutput,
    };

    // Transition state: PENDING -> RUNNING
    subtask.status = "RUNNING";

    const taskInput: SubagentTaskInput = {
      subtaskId: subtask.id,
      role: subtask.role,
      objective: subtask.objective ?? subtask.description,
      relevantContext: `Plan Goal: "${plan.goal}". Target Files: ${(subtask.targetFiles ?? []).join(", ") || "General"}`,
      constraints: subtask.constraints ?? [
        "Make minimal targeted changes",
        "Do not independently redesign unrelated parts of the project",
        "Adhere to allowed file boundaries",
      ],
      expectedOutput: subtask.expectedOutput ?? modelSelection.expectedOutput ?? "Execution result",
      allowedFiles: subtask.allowedFiles ?? subtask.targetFiles ?? [],
      acceptanceCriteria: plan.acceptanceCriteria,
      complexity: subtask.complexity ?? "medium",
      modelSelection,
      fileSystem,
    };

    try {
      let filesCreated: string[] = [];
      let filesModified: string[] = [];
      let filesDeleted: string[] = [];
      let summary = "";
      let error: string | undefined;

      if (typeof subagent.runTask === "function") {
        const report = await subagent.runTask(taskInput);
        summary = report.summary;

        if (!report.success) {
          return {
            ...subtask,
            status: "FAILED",
            result: {
              filesCreated: [],
              filesModified: [],
              filesDeleted: [],
              summary: report.summary,
              error: report.error ?? "Subtask execution reported failure",
            },
          };
        }

        // ─────────────────────────────────────────────────────────────
        // ORCHESTRATOR ACCEPTANCE / REJECTION GATE & CONFLICT RESOLUTION
        // The orchestrator is solely responsible for integration and final changes.
        // ─────────────────────────────────────────────────────────────

        // Check 1: Boundary enforcement
        if (report.boundaryViolations && report.boundaryViolations.length > 0) {
          return {
            ...subtask,
            status: "REJECTED",
            rejectionReason: `Boundary violation: ${report.boundaryViolations.join("; ")}`,
            result: {
              filesCreated: [],
              filesModified: [],
              filesDeleted: [],
              summary: `Rejected by orchestrator: boundary constraints violated.`,
              error: report.boundaryViolations.join("; "),
            },
          };
        }

        // Check 2: Conflict resolution & write integration
        const candidateCreates = report.proposedChanges?.filesCreated ?? [];
        const candidateModifies = report.proposedChanges?.filesModified ?? [];
        const candidateDeletes = report.proposedChanges?.filesDeleted ?? [];

        // Check for conflicting overwrites
        for (const file of [...candidateCreates, ...candidateModifies]) {
          const priorModifier = sessionModifiedFiles.get(file.path);
          if (priorModifier && priorModifier !== subtask.id) {
            // Orchestrator conflict resolution: warn and integrate under lead supervision
            summary += ` [Note: Orchestrator resolved sequential touch on ${file.path} from ${priorModifier}]`;
          }
          sessionModifiedFiles.set(file.path, subtask.id);
        }

        // Apply accepted changes to file system
        for (const file of candidateCreates) {
          await fileSystem.writeFile(file.path, file.content);
          filesCreated.push(file.path);
        }

        for (const file of candidateModifies) {
          await fileSystem.writeFile(file.path, file.content);
          filesModified.push(file.path);
        }

        for (const file of candidateDeletes) {
          await fileSystem.deleteFile(file);
          filesDeleted.push(file);
        }

        // Subtask changes accepted by orchestrator
        return {
          ...subtask,
          status: "ACCEPTED",
          result: {
            filesCreated,
            filesModified,
            filesDeleted,
            summary: summary || report.summary,
          },
        };
      } else {
        // Fallback to legacy execute()
        const res = await subagent.execute(subtask.description, {
          taskId: subtask.id,
          role: subtask.role,
          complexity: subtask.complexity ?? "medium",
          modelSelection,
          fileSystem,
          metadata: {
            allowedFiles: subtask.allowedFiles,
            acceptanceCriteria: plan.acceptanceCriteria,
          },
        });

        filesCreated = res.filesCreated ?? [];
        filesModified = res.filesModified ?? [];
        filesDeleted = res.filesDeleted ?? [];
        summary = res.summary;
        error = res.error;

        return {
          ...subtask,
          status: res.success ? "ACCEPTED" : "FAILED",
          result: {
            filesCreated,
            filesModified,
            filesDeleted,
            summary,
            error,
          },
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...subtask,
        status: "FAILED",
        result: {
          filesCreated: [],
          filesModified: [],
          filesDeleted: [],
          summary: `Subtask execution threw error: ${message}`,
          error: message,
        },
      };
    }
  }
}
