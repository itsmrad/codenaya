import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { Parser, type ReadEntry } from "tar";
import { NonRetriableError } from "inngest";

// Matches MAX_COPY_FILES (convex/projectCopy.ts): a bigger project couldn't be copied.
export const MAX_IMPORT_FILES = 5000;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export type RepoArchive = {
  folders: string[];
  files: { path: string; content: Buffer<ArrayBuffer> }[];
  // Entries left out, such as symlinks. (Submodules arrive as empty folders.)
  skipped: string[];
};

/**
 * Downloads the repo's default branch (or `ref`) as one tarball and reads it in memory,
 * so an import costs one GitHub API request however many files the repo has
 * (#364). Caps are checked from each entry's header before its body is read.
 */
export async function readRepoArchive(
  owner: string,
  repo: string,
  token: string | null,
  ref?: string
): Promise<RepoArchive> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball${ref ? `/${encodeURIComponent(ref)}` : ""}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    }
  );
  if (!res.ok || !res.body) {
    throw new Error(`GitHub archive download failed: ${res.status}`);
  }

  const archive: RepoArchive = { folders: [], files: [], skipped: [] };
  const reads: Promise<void>[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const parser = new Parser({
    onReadEntry: (entry: ReadEntry) => {
      if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
        parser.abort(new NonRetriableError(`Unsafe path in archive: ${entry.path}`));
        return;
      }
      // GitHub nests everything under "<owner>-<repo>-<sha>/".
      const path = entry.path.split("/").slice(1).join("/").replace(/\/$/, "");
      if (path && entry.type === "Directory") {
        archive.folders.push(path);
      }
      // Symlinks aren't imported; submodules are empty folders in the archive.
      if (path && entry.type !== "File" && entry.type !== "Directory") {
        archive.skipped.push(path);
      }
      if (!path || entry.type !== "File") {
        entry.resume();
        return;
      }

      fileCount += 1;
      totalBytes += entry.size;
      if (fileCount > MAX_IMPORT_FILES || totalBytes > MAX_IMPORT_BYTES) {
        parser.abort(
          new NonRetriableError(
            `Repositories over ${MAX_IMPORT_FILES} files or ${MAX_IMPORT_BYTES / 1024 / 1024} MB can't be imported`
          )
        );
        return;
      }
      reads.push(
        entry.concat().then((content) => {
          archive.files.push({ path, content: content as Buffer<ArrayBuffer> });
        })
      );
    },
  });

  await pipeline(Readable.fromWeb(res.body as ReadableStream), parser);
  await Promise.all(reads);
  return archive;
}
