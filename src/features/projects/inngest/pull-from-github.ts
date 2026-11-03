import { isBinaryFile } from "isbinaryfile";
import type { Octokit } from "octokit";
import { NonRetriableError } from "inngest";

import { convex } from "@/lib/convex-client";
import { getAppError } from "@/lib/convex-error";
import { inngest } from "@/inngest/client";
import { requireJobGithubToken } from "@/features/projects/server/github-token";
import { readRepoArchive } from "@/features/projects/server/github-archive";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { TreeEntry } from "../../../../convex/checkpoints";
import { MAX_TEXT_FILE_BYTES, chunkFiles, uploadBlob } from "./import-github-repo";
import { gitBlobSha } from "./push-to-github";

// Matches MAX_CHECKPOINT_FILES (convex/checkpoints.ts): a bigger project gets
// no checkpoint, so its pull couldn't be undone.
const MAX_PULL_ENTRIES = 2000;

interface PullFromGithubEvent {
  projectId: Id<"projects">;
  userId: string;
  // The remote head the route checked, so the pull applies what the user saw.
  sha: string;
}

/**
 * "Pull from GitHub" (#343): checkpoints the project, then writes the linked
 * branch's tree over it in batches and deletes what the tree doesn't have.
 * Restoring the "Before pull" checkpoint undoes it.
 */
export const pullFromGithub = inngest.createFunction(
  {
    id: "pull-from-github",
    concurrency: [{ key: "event.data.projectId", limit: 1 }],
    triggers: [{ event: "github/sync.pull" }],
    onFailure: async ({ event, error, step }) => {
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
      if (!internalKey) return;

      const { projectId } = event.data.event.data as PullFromGithubEvent;

      await step.run("set-failed-status", async () => {
        await convex.mutation(api.system.updateExportStatus, {
          internalKey,
          projectId,
          status: "failed",
          // Ours are written for the user; anything else stays in the logs.
          error: error.name === "NonRetriableError" ? error.message : undefined,
        });
      });
    },
  },
  async ({ event, step }) => {
    const { projectId, userId, sha } = event.data as PullFromGithubEvent;

    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) {
      throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
    }

    const githubToken = await requireJobGithubToken({ internalKey, userId, projectId });

    const project = await step.run("set-pulling-status", async () => {
      await convex.mutation(api.system.updateExportStatus, {
        internalKey,
        projectId,
        status: "exporting",
      });
      return await convex.query(api.system.getProjectById, { internalKey, projectId });
    });
    if (!project?.githubSync) {
      throw new NonRetriableError("Project is not linked to a GitHub repository");
    }
    const [owner, repo] = project.githubSync.repo.split("/");

    // Its own step, so a retried apply never snapshots a half-pulled project.
    await step.run("create-checkpoint", async () => {
      await convex
        .mutation(api.githubSync.createPullCheckpoint, {
          internalKey,
          projectId,
          label: `Before pull from GitHub @ ${sha.slice(0, 7)}`,
        })
        .catch(refusalIsFinal);
    });

    // One step: the archive can't be passed between steps. A retry writes the
    // same tree again; unchanged files are left alone.
    await step.run("apply-files", async () => {
      const { folders, files, skipped } = await readRepoArchive(owner, repo, githubToken, sha);
      if (folders.length + files.length > MAX_PULL_ENTRIES) {
        throw new NonRetriableError(
          `Repositories over ${MAX_PULL_ENTRIES} files and folders can't be pulled`
        );
      }

      // Text is decoded up front: a file left out would still be in the
      // pulled commit, and the next push would delete it on GitHub.
      const texts = new Map<string, string>();
      for (const file of files) {
        if (await isBinaryFile(file.content)) continue;
        const content = file.content.toString("utf-8");
        if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES) skipped.push(file.path);
        else texts.set(file.path, content);
      }
      if (skipped.length > 0) {
        const named = skipped.slice(0, 5).join(", ");
        const more = skipped.length > 5 ? ` and ${skipped.length - 5} more` : "";
        throw new NonRetriableError(
          `These files can't be pulled (symlinks, or text over ${MAX_TEXT_FILE_BYTES / 1024} KB): ${named}${more}`
        );
      }

      // Paths GitHub no longer has go first (the checkpoint keeps them), so
      // the batches never take the project over the file cap.
      await convex
        .mutation(api.githubSync.applyPulledFiles, {
          internalKey,
          projectId,
          entries: [],
          tree: [
            ...folders.map((path) => ({ path, type: "folder" as const })),
            ...files.map(({ path }) => ({ path, type: "file" as const })),
          ],
        })
        .catch(refusalIsFinal);

      const entries: TreeEntry[] = folders
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .map((path) => ({ path, type: "folder" }));
      for (const file of files) {
        const content = texts.get(file.path);
        if (content !== undefined) {
          entries.push({ path: file.path, type: "file", content });
        } else {
          // shortcut: re-uploads unchanged binaries and applyTree drops the
          // copy; compare hashes first if pulls of asset-heavy repos get slow.
          const storageId = await uploadBlob(internalKey, file.content);
          entries.push({ path: file.path, type: "file", storageId });
        }
      }

      // Folders sort first, so each batch's parents already exist.
      for (const batch of chunkFiles(entries)) {
        await convex
          .mutation(api.githubSync.applyPulledFiles, { internalKey, projectId, entries: batch })
          .catch(refusalIsFinal);
      }
      await convex
        .mutation(api.githubSync.finishPull, { internalKey, projectId, sha })
        .catch(refusalIsFinal);
    });

    await step.run("set-completed-status", async () => {
      await convex.mutation(api.system.updateExportStatus, {
        internalKey,
        projectId,
        status: "completed",
        repoUrl: `https://github.com/${project.githubSync!.repo}`,
      });
    });

    return { success: true, sha };
  }
);

/**
 * Our Convex refusals (an agent started running, the file cap) are final: a
 * retry would only write over the run. Their message is shown to the user.
 */
function refusalIsFinal(error: unknown): never {
  const refusal = getAppError(error);
  throw refusal ? new NonRetriableError(refusal.message) : error;
}

/**
 * Whether the project's files differ from the tree of commit `sha`, the last
 * one synced: any local change, whether a run, a manual edit or a restore.
 */
export async function differsFromCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  files: { path: string; content?: string }[]
) {
  const { data: commit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: sha });
  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "true",
  });
  const remote = new Map(
    tree.tree.flatMap((item) =>
      item.type === "blob" && item.path && item.sha ? [[item.path, item.sha] as const] : []
    )
  );
  // shortcut: binaries count by path only; hash them (one download each) if
  // swapping an image must count as a local change.
  return (
    files.length !== remote.size ||
    files.some(
      ({ path, content }) =>
        !remote.has(path) ||
        (content !== undefined && gitBlobSha(Buffer.from(content)) !== remote.get(path))
    )
  );
}
