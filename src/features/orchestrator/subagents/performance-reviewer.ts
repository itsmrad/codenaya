import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class PerformanceReviewerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "performance-reviewer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const findings: string[] = [];

    findings.push(`Performance review analyzing resource usage for: "${input.objective}"`);

    for (const file of files) {
      // Check for large barrel imports
      if (file.content.includes("from 'lucide-react'") && file.content.split("\n").some((l) => l.includes("import * as Icons from 'lucide-react'"))) {
        findings.push(`OPTIMIZATION: Barrel import of entire lucide-react icon set in ${file.path}; prefer named imports.`);
      }

      // Check for synchronous sequential fetches in loops
      if (file.content.includes("for (") && file.content.includes("await fetch(")) {
        findings.push(`OPTIMIZATION: Sequential await fetch in loop inside ${file.path}; consider Promise.all.`);
      }
    }

    if (findings.length === 1) {
      findings.push("No major performance regressions or synchronous waterfalls detected.");
    }

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: true,
      status: "COMPLETED",
      summary: "Performance review completed.",
      findings,
      proposedChanges: {
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
      },
      boundaryViolations: [],
    };
  }
}
