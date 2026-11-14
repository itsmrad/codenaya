import ky from "ky";
import { isBinaryFile } from "isbinaryfile";
import { NonRetriableError } from "inngest";

import { convex } from "@/lib/convex-client";
import { inngest } from "@/inngest/client";
import { getJobGithubToken } from "@/features/projects/server/github-token";
import { readRepoArchive } from "@/features/projects/server/github-archive";
import { planSeedTree, type SeedFile } from "@/features/templates/seed-files";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

// ponytail: fixed caps, well inside Convex's 16 MiB args/writes and 4,096
// queries per mutation (createFiles runs one sibling lookup per file).
export const MAX_BATCH_FILES = 100;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
// A Convex document is capped at 1 MiB; a bigger file would fail its batch.
export const MAX_TEXT_FILE_BYTES = 900 * 1024;

interface ImportGithubRepoEvent {
  owner: string;
  repo: string;
  projectId: Id<"projects">;
  userId: string;
}

export const importGithubRepo = inngest.createFunction(
  {
    id: "import-github-repo",
    // One import per user at a time; more wait in the queue (#242).
    concurrency: [{ key: "event.data.userId", limit: 1 }],
    triggers: [{ event: "github/import.repo" }],
    onFailure: async ({ event, step }) => {
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
      if (!internalKey) return;

      const { projectId } = event.data.event.data as ImportGithubRepoEvent;

      await step.run("set-failed-status", async () => {
        await convex.mutation(api.system.updateImportStatus, {
          internalKey,
          projectId,
          status: "failed",
        });
      });
    },
  },
  async ({ event, step }) => {
    const { owner, repo, projectId, userId } =
      event.data as ImportGithubRepoEvent;

    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) {
      throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
    };

    // No linked account: the route checked the repo is public, so read it
    // unauthenticated (#364).
    const githubToken = await getJobGithubToken({ internalKey, userId, projectId });

    // One step: the archive can't be passed between steps (step output is
    // persisted), and a retry starts again from a clean project.
    await step.run("import-files", async () => {
      // Cleanup deletes one bounded batch per call (#212).
      let cleaned = false;
      while (!cleaned) {
        ({ done: cleaned } = await convex.mutation(api.system.cleanup, {
          internalKey,
          projectId
        }));
      }

      const { folders, files } = await readRepoArchive(owner, repo, githubToken);

      // Sort folders by depth so parents are created before children
      // Input:  ["src/components", "src", "src/components/ui"]
      // Output: ["src", "src/components", "src/components/ui"]
      folders.sort((a, b) => a.split("/").length - b.split("/").length);

      const folderIdMap: Record<string, Id<"files">> = {};

      for (const folder of folders) {
        const pathParts = folder.split("/");
        const name = pathParts.pop()!;
        const parentPath = pathParts.join("/");
        const parentId = parentPath ? folderIdMap[parentPath] : undefined;

        folderIdMap[folder] = await convex.mutation(api.system.createFolder, {
          internalKey,
          projectId,
          name,
          parentId,
        });
      }

      const textFiles: SeedFile[] = [];

      for (const file of files) {
        try {
          const buffer = file.content;
          const isBinary = await isBinaryFile(buffer);

          const pathParts = file.path.split("/");
          const name = pathParts.pop()!;
          const parentPath = pathParts.join("/");
          const parentId = parentPath ? folderIdMap[parentPath] : undefined;

          if (isBinary) {
            const storageId = await uploadBlob(internalKey, buffer);

            await convex.mutation(api.system.createBinaryFile, {
              internalKey,
              projectId,
              name,
              storageId,
              parentId,
            });
          } else {
            const content = buffer.toString("utf-8");
            if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES) {
              console.error(`Failed to import file: ${file.path}`);
            } else {
              textFiles.push({ path: file.path, content });
            }
          }
        } catch {
          console.error(`Failed to import file: ${file.path}`);
        }
      }

      // One write per batch, not per file: each write re-runs every file-list
      // subscriber (#411). A failed batch throws, and the retry starts clean.
      for (const [folder, folderFiles] of planSeedTree(textFiles).filesByFolder) {
        for (const batch of chunkFiles(folderFiles)) {
          await convex.mutation(api.system.createFiles, {
            internalKey,
            projectId,
            parentId: folder ? folderIdMap[folder] : undefined,
            files: batch,
          });
        }
      }
    });

    await step.run("set-completed-status", async () => {
      await convex.mutation(api.system.updateImportStatus, {
        internalKey,
        projectId,
        status: "completed",
      });
    });

    return { success: true, projectId };
  }
);

/** Stores a binary file's bytes in Convex storage. */
export async function uploadBlob(internalKey: string, body: Buffer<ArrayBuffer>) {
  const uploadUrl = await convex.mutation(api.system.generateUploadUrl, { internalKey });
  const { storageId } = await ky
    .post(uploadUrl, {
      headers: { "Content-Type": "application/octet-stream" },
      body,
    })
    .json<{ storageId: Id<"_storage"> }>();
  return storageId;
}

/** Cuts a folder's files into batches within MAX_BATCH_FILES and MAX_BATCH_BYTES. */
export function chunkFiles<T extends { content?: string }>(files: T[]) {
  const batches: T[][] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content ?? "");
    const batch = batches.at(-1);
    if (batch && batch.length < MAX_BATCH_FILES && bytes + size <= MAX_BATCH_BYTES) {
      batch.push(file);
      bytes += size;
    } else {
      batches.push([file]);
      bytes = size;
    }
  }
  return batches;
}
