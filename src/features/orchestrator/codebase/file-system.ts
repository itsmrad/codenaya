import { ProjectFile } from "../types";

export interface ICodebaseFileSystem {
  listFiles(): Promise<ProjectFile[]>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  findFiles(matcher: (file: ProjectFile) => boolean): Promise<ProjectFile[]>;
}

/**
 * In-memory virtual file system, suitable for testing and isolated simulations.
 */
export class InMemoryFileSystem implements ICodebaseFileSystem {
  private files: Map<string, ProjectFile> = new Map();

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      const normalizedPath = this.normalizePath(path);
      const name = normalizedPath.split("/").pop() || normalizedPath;
      this.files.set(normalizedPath, {
        path: normalizedPath,
        name,
        content,
        type: "file",
        updatedAt: Date.now(),
      });
    }
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  }

  async listFiles(): Promise<ProjectFile[]> {
    return Array.from(this.files.values());
  }

  async readFile(path: string): Promise<string | null> {
    const file = this.files.get(this.normalizePath(path));
    return file ? file.content : null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const name = normalized.split("/").pop() || normalized;
    this.files.set(normalized, {
      path: normalized,
      name,
      content,
      type: "file",
      updatedAt: Date.now(),
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.files.delete(this.normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.normalizePath(path));
  }

  async findFiles(matcher: (file: ProjectFile) => boolean): Promise<ProjectFile[]> {
    const all = await this.listFiles();
    return all.filter(matcher);
  }
}
