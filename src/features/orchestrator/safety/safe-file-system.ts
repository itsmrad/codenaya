import { ICodebaseFileSystem } from "../codebase/file-system";
import { ProjectFile } from "../types";
import { GitStatusInspector } from "./git-inspector";

/**
 * Safe File System Wrapper.
 *
 * Enforces Git safety boundaries:
 * 1. Blocks overwriting or deleting user work without explicit authorization.
 * 2. Leaves unrelated user changes untouched.
 * 3. Tracks every write/create/delete for atomic traceability and rollback.
 */
export class SafeFileSystem implements ICodebaseFileSystem {
  private underlying: ICodebaseFileSystem;
  private inspector: GitStatusInspector;
  private authorizedOverrides: string[];
  private createdFiles: Set<string> = new Set();
  private modifiedFiles: Set<string> = new Set();
  private deletedFiles: Set<string> = new Set();

  constructor(
    underlying: ICodebaseFileSystem,
    inspector: GitStatusInspector,
    authorizedOverrides: string[] = []
  ) {
    this.underlying = underlying;
    this.inspector = inspector;
    this.authorizedOverrides = authorizedOverrides.map((p) => inspector.normalizePath(p));
  }

  public normalizePath(path: string): string {
    return this.inspector.normalizePath(path);
  }

  async listFiles(): Promise<ProjectFile[]> {
    return this.underlying.listFiles();
  }

  async readFile(path: string): Promise<string | null> {
    return this.underlying.readFile(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.underlying.exists(path);
  }

  async findFiles(matcher: (file: ProjectFile) => boolean): Promise<ProjectFile[]> {
    return this.underlying.findFiles(matcher);
  }

  /**
   * Safe file write: verifies target file does NOT violate user work boundaries.
   */
  async writeFile(path: string, content: string): Promise<void> {
    const norm = this.normalizePath(path);

    // Guard: Never overwrite unrelated user work without explicit authorization
    this.inspector.assertCanModify(norm, this.authorizedOverrides);

    const alreadyExists = await this.underlying.exists(norm);

    await this.underlying.writeFile(norm, content);

    if (alreadyExists) {
      this.modifiedFiles.add(norm);
    } else {
      this.createdFiles.add(norm);
    }
  }

  /**
   * Safe file delete: verifies target file is not protected user work.
   */
  async deleteFile(path: string): Promise<boolean> {
    const norm = this.normalizePath(path);

    // Guard: Never delete user work without explicit authorization
    this.inspector.assertCanModify(norm, this.authorizedOverrides);

    const existed = await this.underlying.exists(norm);
    if (!existed) return false;

    const success = await this.underlying.deleteFile(norm);
    if (success) {
      this.deletedFiles.add(norm);
      this.createdFiles.delete(norm);
      this.modifiedFiles.delete(norm);
    }
    return success;
  }

  public getCreatedFiles(): string[] {
    return Array.from(this.createdFiles);
  }

  public getModifiedFiles(): string[] {
    return Array.from(this.modifiedFiles);
  }

  public getDeletedFiles(): string[] {
    return Array.from(this.deletedFiles);
  }

  public getTouchedFiles(): string[] {
    const all = new Set([
      ...this.createdFiles,
      ...this.modifiedFiles,
      ...this.deletedFiles,
    ]);
    return Array.from(all);
  }

  public resetTracking(): void {
    this.createdFiles.clear();
    this.modifiedFiles.clear();
    this.deletedFiles.clear();
  }

  public authorizeOverride(path: string): void {
    this.authorizedOverrides.push(this.normalizePath(path));
  }
}

