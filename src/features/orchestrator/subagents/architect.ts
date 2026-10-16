import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole, CodebaseInspection } from "../types";

export class ArchitectSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "architect";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const filePaths = files.map((f) => f.path);

    // Identify project framework
    let framework: CodebaseInspection["framework"] = "unknown";
    if (filePaths.some((p) => p.includes("next.config") || p.startsWith("src/app"))) {
      framework = "nextjs";
    } else if (filePaths.some((p) => p.includes("vite.config") || p.includes("index.html"))) {
      framework = "vite";
    }

    // Identify styling
    let styling: CodebaseInspection["styling"] = "unknown";
    if (filePaths.some((p) => p.includes("components.json"))) {
      styling = "shadcn";
    } else if (filePaths.some((p) => p.includes("tailwind.config") || p.includes("globals.css"))) {
      styling = "tailwind";
    }

    // Inspect package.json
    let dependencies: Record<string, string> = {};
    const pkgJson = await input.fileSystem.readFile("package.json");
    if (pkgJson) {
      try {
        const parsed = JSON.parse(pkgJson);
        dependencies = {
          ...(parsed.dependencies || {}),
          ...(parsed.devDependencies || {}),
        };
      } catch {
        // Fallback
      }
    }

    const hasTypeScript = filePaths.some((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
    const entryPoints = filePaths.filter(
      (p) =>
        p.endsWith("page.tsx") ||
        p.endsWith("App.tsx") ||
        p.endsWith("main.tsx") ||
        p.endsWith("index.ts")
    );

    const patterns: string[] = [];
    if (styling === "shadcn") patterns.push("shadcn/ui component primitives with Tailwind CSS");
    if (framework === "nextjs") patterns.push("Next.js App Router conventions (src/app)");
    if (hasTypeScript) patterns.push("Strict TypeScript interfaces and types");
    if (dependencies["zustand"]) patterns.push("Zustand client state management");
    if (dependencies["react-hook-form"]) patterns.push("react-hook-form with zod validation");

    const inspection: CodebaseInspection = {
      framework,
      styling,
      hasTypeScript,
      packageDependencies: dependencies,
      keyDirectories: Array.from(
        new Set(
          filePaths
            .map((p) => {
              const segs = p.split("/");
              return segs.length > 1 ? segs.slice(0, 2).join("/") : segs[0];
            })
            .filter(Boolean)
        )
      ),
      existingFiles: filePaths,
      patterns,
      entryPoints,
      summary: `Analyzed codebase: ${framework} (${hasTypeScript ? "TypeScript" : "JavaScript"}) with ${styling} styling. Found ${filePaths.length} existing files.`,
    };

    const findings: string[] = [
      `Target architectural framework: ${framework}`,
      `Styling system: ${styling}`,
      `TypeScript support: ${hasTypeScript ? "Enabled" : "Disabled"}`,
    ];

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: true,
      status: "COMPLETED",
      summary: inspection.summary || "Architecture inspection completed.",
      findings,
      proposedChanges: {
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
      },
      boundaryViolations: [],
      data: { inspection },
    };
  }
}
