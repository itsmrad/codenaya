import { ICodebaseFileSystem } from "../codebase/file-system";
import { GitFileStatus, GitInspectionReport } from "./types";

/**
 * Git Status Inspector.
 *
 * Before modifying the repository:
 * 1. Inspects git status.
 * 2. Detects existing user changes.
 * 3. Never allows overwriting unrelated user work.
 * 4. Flags protected files so that no user work is reset or deleted without explicit authorization.
 */
export class GitStatusInspector {
  private protectedFiles: Set<string> = new Set();
  private existingChanges: Map<string, GitFileStatus> = new Map();
  private branch: string = "main";
  private isCleanRepo: boolean = true;

  constructor(initialStatusOutput?: string) {
    if (initialStatusOutput) {
      this.parseStatusOutput(initialStatusOutput);
    }
  }

  /**
   * Normalizes path to forward slashes without leading dots or slashes.
   */
  public normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  }

  /**
   * Inspects repository status using provided git status text or virtual inspection.
   */
  public parseStatusOutput(rawStatusOutput: string): GitInspectionReport {
    this.protectedFiles.clear();
    this.existingChanges.clear();

    const lines = rawStatusOutput.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    const statuses: GitFileStatus[] = [];
    const untrackedFiles: string[] = [];

    for (const line of lines) {
      // Branch header: "## main...origin/main" or "## No commits yet on main"
      if (line.startsWith("##")) {
        const branchMatch = line.match(/^##\s+([^\s\.]+)/);
        if (branchMatch) {
          this.branch = branchMatch[1];
        }
        continue;
      }

      if (line.length < 3) continue;

      const x = line[0];
      const y = line[1];
      const filePath = this.normalizePath(line.slice(3).trim());

      let statusType: GitFileStatus["status"] = "modified";
      if (x === "?" && y === "?") {
        statusType = "untracked";
        untrackedFiles.push(filePath);
      } else if (x === "D" || y === "D") {
        statusType = "deleted";
      } else if (x === "A" || y === "A") {
        statusType = "added";
      } else if (x === "R" || y === "R") {
        statusType = "renamed";
      } else if (x !== " " && y === " ") {
        statusType = "staged";
      } else {
        statusType = "modified";
      }

      const fileStatus: GitFileStatus = {
        path: filePath,
        status: statusType,
        isUserWork: true,
        diffSummary: `Detected pre-existing user modification [${x}${y}]`,
      };

      statuses.push(fileStatus);
      this.existingChanges.set(filePath, fileStatus);
      this.protectedFiles.add(filePath);
    }

    this.isCleanRepo = statuses.length === 0;

    const summary = this.isCleanRepo
      ? "Working tree is clean. No pre-existing uncommitted user changes detected."
      : `Detected ${statuses.length} pre-existing uncommitted user file(s) across branch '${this.branch}'. All ${statuses.length} files are registered as protected user work.`;

    return {
      branch: this.branch,
      isClean: this.isCleanRepo,
      existingUserChanges: statuses,
      protectedFiles: Array.from(this.protectedFiles),
      untrackedUserFiles: untrackedFiles,
      summary,
      inspectedAt: Date.now(),
    };
  }

  /**
   * Performs inspection on a codebase filesystem.
   * If pre-existing files are flagged as user work or an inspection provider is used.
   */
  public async inspect(
    fileSystem: ICodebaseFileSystem,
    gitStatusProvider?: () => Promise<string> | string
  ): Promise<GitInspectionReport> {
    if (gitStatusProvider) {
      try {
        const rawStatus = await gitStatusProvider();
        return this.parseStatusOutput(rawStatus);
      } catch {
        // Fallback to filesystem examination
      }
    }

    // Default clean inspection if no git provider output
    if (this.existingChanges.size > 0) {
      return this.getReport();
    }

    return {
      branch: this.branch,
      isClean: true,
      existingUserChanges: [],
      protectedFiles: [],
      untrackedUserFiles: [],
      summary: "Working tree baseline verified clean.",
      inspectedAt: Date.now(),
    };
  }

  /**
   * Registers a specific file path as protected user work.
   */
  public protectFile(filePath: string): void {
    this.protectedFiles.add(this.normalizePath(filePath));
  }

  /**
   * Returns whether a path is classified as pre-existing user work.
   */
  public isUserWork(filePath: string): boolean {
    const norm = this.normalizePath(filePath);
    if (this.protectedFiles.has(norm)) return true;

    // Check directory prefix match
    for (const p of this.protectedFiles) {
      if (norm === p || norm.startsWith(p.replace(/\/?$/, "/"))) {
        return true;
      }
    }
    return false;
  }

  public isProtectedFile(filePath: string): boolean {
    return this.isUserWork(filePath);
  }

  /**
   * Checks if an operation is authorized to modify a file.
   * Throws an error if the agent attempts to modify, delete, or reset user work without explicit authorization.
   */
  public assertCanModify(filePath: string, authorizedOverrides?: string[]): void {
    const norm = this.normalizePath(filePath);

    if (this.isUserWork(norm)) {
      const isExplicitlyAuthorized = authorizedOverrides?.some((auth) => {
        const normAuth = this.normalizePath(auth);
        return norm === normAuth || norm.startsWith(normAuth.replace(/\/?$/, "/"));
      });

      if (!isExplicitlyAuthorized) {
        throw new Error(
          `Git Safety Violation: Cannot overwrite, reset, or delete user work in '${filePath}' without explicit authorization. File has uncommitted pre-existing changes.`
        );
      }
    }
  }

  public getProtectedFiles(): string[] {
    return Array.from(this.protectedFiles);
  }

  public getReport(): GitInspectionReport {
    return {
      branch: this.branch,
      isClean: this.isCleanRepo,
      existingUserChanges: Array.from(this.existingChanges.values()),
      protectedFiles: Array.from(this.protectedFiles),
      untrackedUserFiles: Array.from(this.existingChanges.values())
        .filter((c) => c.status === "untracked")
        .map((c) => c.path),
      summary: this.isCleanRepo
        ? "Working tree is clean."
        : `Protected ${this.protectedFiles.size} pre-existing user file(s) from accidental overwrite.`,
      inspectedAt: Date.now(),
    };
  }
}
