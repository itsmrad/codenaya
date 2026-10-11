import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class BackendEngineerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "backend-engineer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const findings: string[] = [];
    const boundaryViolations: string[] = [];
    const filesCreated: Array<{ path: string; content: string }> = [];
    const filesModified: Array<{ path: string; content: string }> = [];

    findings.push(`Backend Engineer processing: "${input.objective}"`);

    const payload = input.metadata?.payload as
      | { action: "create" | "update"; filePath: string; content: string }
      | undefined;

    if (payload) {
      if (!this.isFileAllowed(payload.filePath, input.allowedFiles)) {
        boundaryViolations.push(
          `Forbidden backend modification: ${payload.filePath} is outside allowed boundaries (${input.allowedFiles.join(", ")})`
        );
      } else {
        const exists = await input.fileSystem.exists(payload.filePath);
        if (exists) {
          filesModified.push({ path: payload.filePath, content: payload.content });
        } else {
          filesCreated.push({ path: payload.filePath, content: payload.content });
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
        ? `Backend logic prepared: ${filesCreated.length} created, ${filesModified.length} modified.`
        : `Backend task failed boundary checks: ${boundaryViolations.join("; ")}`,
      findings,
      proposedChanges: {
        filesCreated,
        filesModified,
        filesDeleted: [],
      },
      boundaryViolations,
      error: success ? undefined : boundaryViolations.join("; "),
    };
  }
}
