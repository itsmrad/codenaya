import { ICodebaseFileSystem } from "../codebase/file-system";
import { ArchitectSubagent } from "../subagents/architect";
import { CodebaseInspection, TaskComplexity } from "../types";

/**
 * Phase 2: Inspect
 * Deeply inspects the existing codebase before any code changes are made.
 * Identifies the relevant architecture, files, dependencies, and existing patterns.
 */
export async function inspectCodebase(
  fileSystem: ICodebaseFileSystem,
  estimatedComplexity: TaskComplexity = "medium"
): Promise<CodebaseInspection> {
  const architect = new ArchitectSubagent();

  const result = await architect.execute("Inspect codebase architecture", {
    taskId: "inspect-" + Date.now(),
    role: "architect",
    complexity: estimatedComplexity,
    modelSelection: {
      provider: "mock",
      modelId: "architect-model",
      tier: "advanced",
      reason: "Architecture inspection",
    },
    fileSystem,
  });

  const inspection = result.data?.inspection as CodebaseInspection | undefined;

  if (!inspection) {
    const files = await fileSystem.listFiles();
    return {
      framework: "unknown",
      styling: "unknown",
      hasTypeScript: files.some((f) => f.path.endsWith(".ts") || f.path.endsWith(".tsx")),
      packageDependencies: {},
      keyDirectories: [],
      existingFiles: files.map((f) => f.path),
      patterns: [],
      entryPoints: [],
      summary: `Discovered ${files.length} existing project files.`,
    };
  }

  return inspection;
}
