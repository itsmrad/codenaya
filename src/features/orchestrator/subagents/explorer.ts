import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole } from "../types";

export class ExplorerSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "explorer";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const findings: string[] = [];

    findings.push(`Scanned repository: found ${files.length} total files.`);

    const keyConfigs = files.filter(
      (f) =>
        f.name === "package.json" ||
        f.name.includes("tsconfig") ||
        f.name.includes("tailwind") ||
        f.name.includes("components.json") ||
        f.name.includes("next.config") ||
        f.name.includes("vite.config")
    );

    if (keyConfigs.length > 0) {
      findings.push(
        `Discovered key project configurations: ${keyConfigs.map((c) => c.name).join(", ")}`
      );
    }

    const directories = Array.from(
      new Set(
        files
          .map((f) => {
            const parts = f.path.split("/");
            return parts.length > 1 ? parts[0] : "";
          })
          .filter(Boolean)
      )
    );

    findings.push(`Identified top-level directories: ${directories.join(", ")}`);

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: true,
      status: "COMPLETED",
      summary: `Repository exploration complete: mapped ${files.length} files across ${directories.length} directories.`,
      findings,
      proposedChanges: {
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
      },
      boundaryViolations: [],
      data: {
        totalFiles: files.length,
        directories,
        configs: keyConfigs.map((c) => c.path),
      },
    };
  }
}
