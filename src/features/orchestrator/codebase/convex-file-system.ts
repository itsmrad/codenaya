import { ICodebaseFileSystem } from "./file-system";
import { ProjectFile } from "../types";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export interface ConvexFileRecord {
  _id: string;
  name: string;
  type: "file" | "folder";
  content?: string;
  parentId?: string | null;
  projectId: string;
  updatedAt?: number;
}

export interface ConvexClientLike {
  query: <T = unknown>(query: unknown, args: Record<string, unknown>) => Promise<T>;
  mutation: <T = unknown>(mutation: unknown, args: Record<string, unknown>) => Promise<T>;
}

export class ConvexFileSystem implements ICodebaseFileSystem {
  private internalKey: string;
  private projectId: Id<"projects">;
  private clientPromise?: Promise<ConvexClientLike>;

  constructor(opts: {
    internalKey: string;
    projectId: Id<"projects">;
    client?: ConvexClientLike;
  }) {
    this.internalKey = opts.internalKey;
    this.projectId = opts.projectId;
    if (opts.client) {
      this.clientPromise = Promise.resolve(opts.client);
    }
  }

  private async getClient(): Promise<ConvexClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = import("@/lib/convex-client").then(
        (m) => m.convex as unknown as ConvexClientLike
      );
    }
    return this.clientPromise;
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  }

  /**
   * Reconstruct full paths for all files and folders in the Convex project.
   */
  async listFiles(): Promise<ProjectFile[]> {
    const client = await this.getClient();
    const rawFiles = await client.query<ConvexFileRecord[]>(api.system.getProjectFiles, {
      internalKey: this.internalKey,
      projectId: this.projectId,
    });

    const fileMap = new Map<string, ConvexFileRecord>();
    for (const f of rawFiles) {
      fileMap.set(f._id, f);
    }

    const getFullPath = (fileId: string): string => {
      const item = fileMap.get(fileId);
      if (!item) return "";
      if (!item.parentId) return item.name;
      const parentPath = getFullPath(item.parentId);
      return parentPath ? `${parentPath}/${item.name}` : item.name;
    };

    return rawFiles
      .filter((f) => f.type === "file")
      .map((f) => ({
        id: f._id,
        path: getFullPath(f._id),
        name: f.name,
        content: f.content ?? "",
        parentId: f.parentId ?? null,
        type: "file",
        updatedAt: f.updatedAt,
      }));
  }

  async readFile(path: string): Promise<string | null> {
    const normalized = this.normalizePath(path);
    const all = await this.listFiles();
    const match = all.find((f) => this.normalizePath(f.path) === normalized);
    if (!match) return null;
    return match.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const client = await this.getClient();
    const normalized = this.normalizePath(path);
    const rawFiles = await client.query<ConvexFileRecord[]>(api.system.getProjectFiles, {
      internalKey: this.internalKey,
      projectId: this.projectId,
    });

    const fileMap = new Map<string, ConvexFileRecord>();
    for (const f of rawFiles) {
      fileMap.set(f._id, f);
    }

    const getFullPath = (fileId: string): string => {
      const item = fileMap.get(fileId);
      if (!item) return "";
      if (!item.parentId) return item.name;
      const parentPath = getFullPath(item.parentId);
      return parentPath ? `${parentPath}/${item.name}` : item.name;
    };

    const existing = rawFiles.find(
      (f) => f.type === "file" && this.normalizePath(getFullPath(f._id)) === normalized
    );

    if (existing) {
      await client.mutation(api.system.updateFile, {
        internalKey: this.internalKey,
        fileId: existing._id,
        content,
      });
      return;
    }

    // Build directory hierarchy if needed
    const parts = normalized.split("/");
    const fileName = parts.pop()!;
    let currentParentId: Id<"files"> | undefined = undefined;

    for (const segment of parts) {
      const folderMatch = rawFiles.find(
        (f: ConvexFileRecord) =>
          f.type === "folder" &&
          f.name === segment &&
          (currentParentId ? f.parentId === currentParentId : !f.parentId)
      );

      if (folderMatch) {
        currentParentId = folderMatch._id as Id<"files">;
      } else {
        const newFolderId = await client.mutation(api.system.createFolder, {
          internalKey: this.internalKey,
          projectId: this.projectId,
          name: segment,
          parentId: currentParentId,
        });
        currentParentId = newFolderId as Id<"files">;
      }
    }

    await client.mutation(api.system.createFile, {
      internalKey: this.internalKey,
      projectId: this.projectId,
      name: fileName,
      content,
      parentId: currentParentId,
    });
  }

  async deleteFile(path: string): Promise<boolean> {
    const client = await this.getClient();
    const normalized = this.normalizePath(path);
    const all = await this.listFiles();
    const match = all.find((f) => this.normalizePath(f.path) === normalized);
    if (!match || !match.id) return false;

    await client.mutation(api.system.deleteFile, {
      internalKey: this.internalKey,
      fileId: match.id as Id<"files">,
    });
    return true;
  }

  async exists(path: string): Promise<boolean> {
    const content = await this.readFile(path);
    return content !== null;
  }

  async findFiles(matcher: (file: ProjectFile) => boolean): Promise<ProjectFile[]> {
    const all = await this.listFiles();
    return all.filter(matcher);
  }
}
