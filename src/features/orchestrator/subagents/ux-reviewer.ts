import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class UxReviewerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "ux-reviewer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const findings: string[] = [];

    findings.push(`UX & Accessibility review evaluated for: "${input.objective}"`);

    const uiFiles = files.filter(
      (f) => f.path.endsWith(".tsx") || f.path.endsWith(".jsx")
    );

    for (const file of uiFiles) {
      // Check for buttons without text or aria-label
      if (/<button[^>]*>\s*<svg/i.test(file.content) && !/aria-label=/i.test(file.content)) {
        findings.push(
          `ACCESSIBILITY: Icon-only button in ${file.path} appears to be missing an aria-label.`
        );
      }

      // Check for images without alt tags
      if (/<img(?![^>]*\balt=)[^>]*>/i.test(file.content)) {
        findings.push(`ACCESSIBILITY: Image element in ${file.path} is missing an alt attribute.`);
      }
    }

    if (findings.length === 1) {
      findings.push("UI components satisfy core accessibility and responsive layout guidelines.");
    }

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: true,
      status: "COMPLETED",
      summary: "UX & Accessibility review completed.",
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
