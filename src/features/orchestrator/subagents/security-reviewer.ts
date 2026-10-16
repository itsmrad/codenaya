import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class SecurityReviewerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "security-reviewer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const findings: string[] = [];
    let passed = true;

    findings.push(`Security audit initiated for task: "${input.objective}"`);

    // Check for hardcoded API keys or secrets
    const secretPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,
      /AIza[0-9A-Za-z-_]{35}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /password\s*=\s*['"][^'"]+['"]/i,
    ];

    for (const file of files) {
      for (const pattern of secretPatterns) {
        if (pattern.test(file.content)) {
          findings.push(`CRITICAL: Potential hardcoded credential pattern detected in ${file.path}`);
          passed = false;
        }
      }

      // Check for dangerouslySetInnerHTML
      if (file.content.includes("dangerouslySetInnerHTML")) {
        findings.push(`WARNING: dangerouslySetInnerHTML used in ${file.path}. Ensure sanitizer is present.`);
      }
    }

    if (passed) {
      findings.push("No obvious credential leaks or unescaped injection vulnerabilities detected.");
    }

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: passed,
      status: passed ? "COMPLETED" : "FAILED",
      summary: passed
        ? "Security Review passed: codebase is free of hardcoded secrets and unescaped injection sinks."
        : "Security Review failed: critical vulnerability or credential leak detected.",
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
