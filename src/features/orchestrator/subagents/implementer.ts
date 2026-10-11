import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export interface ImplementerTaskPayload {
  action: "create" | "update" | "delete";
  filePath: string;
  content?: string;
  diffSummary?: string;
}

export class ImplementerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "implementer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const payload = input.metadata?.payload as ImplementerTaskPayload | undefined;
    const filesCreated: Array<{ path: string; content: string }> = [];
    const filesModified: Array<{ path: string; content: string }> = [];
    const filesDeleted: string[] = [];
    const boundaryViolations: string[] = [];

    if (payload) {
      if (!this.isFileAllowed(payload.filePath, input.allowedFiles)) {
        boundaryViolations.push(
          `Forbidden modification: ${payload.filePath} is outside allowed boundaries (${input.allowedFiles.join(", ")})`
        );
      } else {
        const fileExists = await input.fileSystem.exists(payload.filePath);
        if (payload.action === "create" || payload.action === "update") {
          if (fileExists) {
            filesModified.push({ path: payload.filePath, content: payload.content ?? "" });
          } else {
            filesCreated.push({ path: payload.filePath, content: payload.content ?? "" });
          }
        } else if (payload.action === "delete") {
          filesDeleted.push(payload.filePath);
        }
      }
    }

    const success = boundaryViolations.length === 0;

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success,
      status: success ? "COMPLETED" : "FAILED",
      summary: success
        ? `Implemented: ${payload?.diffSummary ?? input.objective}`
        : `Boundary violation in implementation: ${boundaryViolations.join("; ")}`,
      findings: [`Objective: ${input.objective}`],
      proposedChanges: {
        filesCreated,
        filesModified,
        filesDeleted,
      },
      boundaryViolations,
      error: success ? undefined : boundaryViolations.join("; "),
    };
  }
}
