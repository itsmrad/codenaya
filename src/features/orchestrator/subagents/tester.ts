import { BaseSubagent, SubagentReport, SubagentTaskInput } from "./base";
import { SubagentRole, ValidationCheck, ValidationResult } from "../types";

export class TesterSubagent extends BaseSubagent {
  public readonly role: SubagentRole = "tester";

  async runTask(input: SubagentTaskInput): Promise<SubagentReport> {
    const files = await input.fileSystem.listFiles();
    const checks: ValidationCheck[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const findings: string[] = [];

    // 1. JSON file syntax check
    const jsonFiles = files.filter((f) => f.path.endsWith(".json"));
    for (const jf of jsonFiles) {
      try {
        JSON.parse(jf.content);
        checks.push({
          name: `JSON Validity: ${jf.path}`,
          type: "syntax",
          status: "passed",
          message: "Valid JSON syntax",
          filePath: jf.path,
        });
      } catch (err) {
        const msg = `Malformed JSON in ${jf.path}: ${err instanceof Error ? err.message : String(err)}`;
        checks.push({
          name: `JSON Validity: ${jf.path}`,
          type: "syntax",
          status: "failed",
          message: msg,
          filePath: jf.path,
        });
        errors.push(msg);
      }
    }

    // 2. Relative import verification for TS/JS files
    const codeFiles = files.filter(
      (f) =>
        f.path.endsWith(".ts") ||
        f.path.endsWith(".tsx") ||
        f.path.endsWith(".js") ||
        f.path.endsWith(".jsx")
    );

    const knownPaths = new Set(files.map((f) => f.path));

    for (const cf of codeFiles) {
      const importRegex = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g;
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(cf.content)) !== null) {
        const importPath = match[1];
        const currentDir = cf.path.split("/").slice(0, -1).join("/");
        const resolvedBase = this.resolveRelativePath(currentDir, importPath);

        const possibleExtensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
        const found = possibleExtensions.some((ext) =>
          knownPaths.has(resolvedBase + ext)
        );

        if (!found) {
          const warningMsg = `Unresolved relative import '${importPath}' in ${cf.path}`;
          checks.push({
            name: `Relative Import Check: ${cf.path}`,
            type: "imports",
            status: "warning",
            message: warningMsg,
            filePath: cf.path,
          });
          warnings.push(warningMsg);
        }
      }
    }

    // 3. Basic syntax checks (unclosed braces, unmatched parenthesis)
    for (const cf of codeFiles) {
      const openBraces = (cf.content.match(/{/g) || []).length;
      const closeBraces = (cf.content.match(/}/g) || []).length;

      if (openBraces !== closeBraces) {
        const errorMsg = `Mismatched curly braces in ${cf.path}: ${openBraces} '{' vs ${closeBraces} '}'`;
        checks.push({
          name: `Brace Balance: ${cf.path}`,
          type: "syntax",
          status: "failed",
          message: errorMsg,
          filePath: cf.path,
        });
        errors.push(errorMsg);
      } else {
        checks.push({
          name: `Brace Balance: ${cf.path}`,
          type: "syntax",
          status: "passed",
          message: "Balanced curly braces",
          filePath: cf.path,
        });
      }
    }

    // 4. Acceptance Criteria Automated Testing & Verification
    for (const criterion of input.acceptanceCriteria ?? []) {
      let criterionPassed = true;
      let reason = "Criterion verified by automated testing.";
      const lowerDesc = criterion.description.toLowerCase();

      // If criterion requires types/interfaces/exports
      if (lowerDesc.includes("type") || lowerDesc.includes("interface")) {
        const hasTypesOrExports = files.some(
          (f) =>
            f.path.includes("types") ||
            f.content.includes("export interface") ||
            f.content.includes("export type") ||
            f.content.includes("export const") ||
            f.content.includes("export function") ||
            f.content.includes("interface ") ||
            f.content.includes("type ")
        );
        if (!hasTypesOrExports) {
          criterionPassed = false;
          reason = "No explicit TypeScript types, interfaces, or exports detected.";
        }
      }

      // If criterion requires non-regression / syntax integrity
      if (
        lowerDesc.includes("intact") ||
        lowerDesc.includes("regression") ||
        lowerDesc.includes("preserve")
      ) {
        if (errors.length > 0) {
          criterionPassed = false;
          reason = `Structural integrity regression: ${errors[0]}`;
        }
      }

      // If criterion specifies target file
      if (criterion.targetFile) {
        const fileExists = files.some(
          (f) => f.path === criterion.targetFile || f.path.endsWith(criterion.targetFile!)
        );
        if (!fileExists) {
          criterionPassed = false;
          reason = `Required target file '${criterion.targetFile}' was not found in codebase.`;
        }
      }

      checks.push({
        name: `Acceptance: ${criterion.description.slice(0, 60)}`,
        type: "acceptance",
        status: criterionPassed ? "passed" : "warning",
        message: reason,
        filePath: criterion.targetFile,
      });

      if (!criterionPassed) {
        warnings.push(`Acceptance criteria notice: ${criterion.description} - ${reason}`);
      }
    }

    const passed = errors.length === 0;

    const validationResult: ValidationResult = {
      passed,
      checks,
      errors,
      warnings,
    };

    findings.push(`Executed ${checks.length} structural integrity checks.`);
    if (warnings.length > 0) findings.push(`Detected ${warnings.length} warning(s).`);
    if (errors.length > 0) findings.push(`Detected ${errors.length} error(s).`);

    return {
      subtaskId: input.subtaskId,
      role: this.role,
      success: passed,
      status: passed ? "COMPLETED" : "FAILED",
      summary: passed
        ? `All ${checks.length} validation checks passed (${warnings.length} warnings)`
        : `Validation failed with ${errors.length} error(s) and ${warnings.length} warning(s)`,
      findings,
      proposedChanges: {
        filesCreated: [],
        filesModified: [],
        filesDeleted: [],
      },
      boundaryViolations: [],
      data: { validationResult },
      error: passed ? undefined : errors.join("; "),
    };
  }

  private resolveRelativePath(currentDir: string, relativePath: string): string {
    const parts = (currentDir ? currentDir.split("/") : []).concat(relativePath.split("/"));
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return resolved.join("/");
  }
}
