import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class FrontendEngineerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "frontend-engineer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const findings: string[] = [];
    const boundaryViolations: string[] = [];
    const filesCreated: Array<{ path: string; content: string }> = [];
    const filesModified: Array<{ path: string; content: string }> = [];

    findings.push(`Frontend Engineer evaluating objective: "${input.objective}"`);

    // Verify allowed file boundaries
    if (input.allowedFiles.length > 0) {
      findings.push(`Scoped to allowed UI boundaries: ${input.allowedFiles.join(", ")}`);
    }

    const payload = input.metadata?.payload as
      | { action: "create" | "update"; filePath: string; content: string }
      | undefined;

    if (payload) {
      if (!this.isFileAllowed(payload.filePath, input.allowedFiles)) {
        boundaryViolations.push(
          `Forbidden modification: ${payload.filePath} is outside allowed areas (${input.allowedFiles.join(", ")})`
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
        ? `Frontend changes prepared: ${filesCreated.length} created, ${filesModified.length} modified.`
        : `Frontend task failed boundary verification: ${boundaryViolations.join("; ")}`,
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
