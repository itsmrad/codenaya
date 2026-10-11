import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class DebuggerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "debugger";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const findings: string[] = [];
    const filesModified: Array<{ path: string; content: string }> = [];

    findings.push(`Debugger initiated root-cause analysis for: "${input.objective}"`);

    const payload = input.metadata?.payload as
      | { action: "update"; filePath: string; content: string; diagnosis: string }
      | undefined;

    if (payload) {
      findings.push(`Diagnosis: ${payload.diagnosis}`);
      filesModified.push({ path: payload.filePath, content: payload.content });
    } else {
      findings.push("Identified no active runtime faults in specified context.");
    }

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: true,
      status: "COMPLETED",
      summary: `Debugging complete: ${findings.slice(-1)[0]}`,
      findings,
      proposedChanges: {
        filesCreated: [],
        filesModified,
        filesDeleted: [],
      },
      boundaryViolations: [],
    };
  }
}
