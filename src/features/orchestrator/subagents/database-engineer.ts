import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class DatabaseEngineerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "database-engineer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const findings: string[] = [];
    const boundaryViolations: string[] = [];
    const filesCreated: Array<{ path: string; content: string }> = [];
    const filesModified: Array<{ path: string; content: string }> = [];

    findings.push(`Database Engineer evaluating schema requirements for: "${input.objective}"`);

    // Verify database files (e.g. convex/schema.ts, migrations, prisma)
    const schemaFile = await input.fileSystem.readFile("convex/schema.ts");
    if (schemaFile) {
      findings.push("Inspected Convex schema definition.");
    }

    const payload = input.metadata?.payload as
      | { action: "create" | "update"; filePath: string; content: string }
      | undefined;

    if (payload) {
      if (!this.isFileAllowed(payload.filePath, input.allowedFiles)) {
        boundaryViolations.push(
          `Forbidden database modification: ${payload.filePath} is outside allowed boundaries (${input.allowedFiles.join(", ")})`
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
        ? `Database operations prepared with schema consistency.`
        : `Database task rejected due to boundary violations: ${boundaryViolations.join("; ")}`,
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
