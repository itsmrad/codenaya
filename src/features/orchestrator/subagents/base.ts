import { ICodebaseFileSystem } from "../codebase/file-system";
import {
  AcceptanceCriterion,
  ModelSelection,
  SubagentRole,
  SubtaskStatus,
  TaskComplexity,
} from "../types";

/**
 * Explicit input packet provided to every specialized sub-agent.
 */
export interface SubagentTaskInput {
  subtaskId: string;
  role: SubagentRole;
  objective: string;
  relevantContext: string;
  constraints: string[];
  expectedOutput: string;
  allowedFiles: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  complexity: TaskComplexity;
  modelSelection: ModelSelection;
  fileSystem: ICodebaseFileSystem;
  metadata?: Record<string, unknown>;
}

/**
 * Report returned by sub-agents to the orchestrator.
 */
export interface SubagentReport {
  subtaskId: string;
  role: SubagentRole;
  success: boolean;
  status: SubtaskStatus;
  summary: string;
  findings: string[];
  proposedChanges: {
    filesCreated: Array<{ path: string; content: string }>;
    filesModified: Array<{ path: string; content: string }>;
    filesDeleted: string[];
  };
  criteriaAssessments?: {
    criterionId: string;
    satisfied: boolean;
    notes: string;
  }[];
  boundaryViolations: string[];
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Backward compatibility alias for legacy callers.
 */
export interface SubagentContext {
  taskId: string;
  role: SubagentRole;
  complexity: TaskComplexity;
  modelSelection: ModelSelection;
  fileSystem: ICodebaseFileSystem;
  metadata?: Record<string, unknown>;
}

export interface SubagentExecutionResult {
  success: boolean;
  summary: string;
  filesCreated?: string[];
  filesModified?: string[];
  filesDeleted?: string[];
  data?: Record<string, unknown>;
  error?: string;
}

export interface ISubagent {
  readonly role: SubagentRole;
  execute(
    taskDescription: string,
    context: SubagentContext
  ): Promise<SubagentExecutionResult>;
  runTask?(input: SubagentTaskInput): Promise<SubagentReport>;
}

/**
 * Base subagent implementation providing boundary protection and standardized input handling.
 */
export abstract class BaseSubagent implements ISubagent {
  abstract readonly role: SubagentRole;

  abstract runTask(input: SubagentTaskInput): Promise<SubagentReport>;

  /**
   * Adapts legacy execute() calls into standardized runTask() calls.
   */
  async execute(
    taskDescription: string,
    context: SubagentContext
  ): Promise<SubagentExecutionResult> {
    const allowedFiles = (context.metadata?.allowedFiles as string[]) ?? [];
    const acceptanceCriteria = (context.metadata?.acceptanceCriteria as AcceptanceCriterion[]) ?? [];
    const constraints = (context.metadata?.constraints as string[]) ?? [
      "Make minimal targeted changes",
      "Do not redesign unrelated parts of the project",
      "Adhere strictly to allowed file boundaries",
    ];

    const report = await this.runTask({
      subtaskId: context.taskId,
      role: this.role,
      objective: taskDescription,
      relevantContext: (context.metadata?.context as string) ?? taskDescription,
      constraints,
      expectedOutput: (context.metadata?.expectedOutput as string) ?? "Execution result",
      allowedFiles,
      acceptanceCriteria,
      complexity: context.complexity,
      modelSelection: context.modelSelection,
      fileSystem: context.fileSystem,
      metadata: context.metadata,
    });

    return {
      success: report.success,
      summary: report.summary,
      filesCreated: report.proposedChanges.filesCreated.map((f) => f.path),
      filesModified: report.proposedChanges.filesModified.map((f) => f.path),
      filesDeleted: report.proposedChanges.filesDeleted,
      data: { ...report.data, report },
      error: report.error,
    };
  }

  /**
   * Verify that a modified or created file path is within allowed boundaries.
   * If allowedFiles is empty, the agent is granted workspace-wide access.
   */
  protected isFileAllowed(filePath: string, allowedFiles: string[]): boolean {
    if (allowedFiles.length === 0) return true;
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    return allowedFiles.some((allowed) => {
      const normAllowed = allowed.replace(/\\/g, "/").replace(/^\.\//, "");
      // Exact match or folder prefix match
      return normalized === normAllowed || normalized.startsWith(normAllowed.replace(/\/?$/, "/"));
    });
  }
}
