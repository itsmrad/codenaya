import { createHash } from "node:crypto";

import ky from "ky";
import { Octokit, RequestError } from "octokit";
import { NonRetriableError } from "inngest";

import { convex } from "@/lib/convex-client";
import { inngest } from "@/inngest/client";
import { requireJobGithubToken } from "@/features/projects/server/github-token";
import { getFilePath } from "@/features/sandbox-preview/utils/file-tree";
import { scanProject } from "@/features/security/scan-project";
import { storedScanEnv } from "@/features/security/server/scan-stored-project";

import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import { GITHUB_SYNC_BRANCH } from "../constants";

interface PushToGithubEvent {
  projectId: Id<"projects">;
  userId: string;
}

/** A file as one commit's tree holds it. Binary files carry a download URL. */
interface SnapshotFile {
  path: string;
  content?: string;
  storageId?: Id<"_storage">;
  storageUrl?: string | null;
}

type GithubSync = NonNullable<Doc<"projects">["githubSync"]>;

/**
 * "Push changes" (#343): commits the agent runs since the last sync on top of
 * the linked branch, one commit per run, and moves the branch by fast-forward
 * only. If the branch moved elsewhere, the commits go to GITHUB_SYNC_BRANCH.
 */
export const pushToGithub = inngest.createFunction(
  {
    id: "push-to-github",
    // Two pushes of one project would build on the same parent.
    concurrency: [{ key: "event.data.projectId", limit: 1 }],
    cancelOn: [
      {
        event: "github/export.cancel",
        if: "event.data.projectId == async.data.projectId",
      },
    ],
    triggers: [{ event: "github/sync.push" }],
    onFailure: async ({ event, error, step }) => {
      const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
      if (!internalKey) return;

      const { projectId } = event.data.event.data as PushToGithubEvent;

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
    const { projectId, userId } = event.data as PushToGithubEvent;

    const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;
    if (!internalKey) {
      throw new NonRetriableError("CODENAYA_CONVEX_INTERNAL_KEY is not configured");
    }

    const githubToken = await requireJobGithubToken({ internalKey, userId, projectId });

    await step.run("set-pushing-status", async () => {
      await convex.mutation(api.system.updateExportStatus, {
        internalKey,
        projectId,
        status: "exporting",
      });
    });

    // One step: the trees are too big to persist between steps. A retry makes
    // its commits again; the ones a failed attempt left are never referenced.
    const result = await step.run("push-commits", () =>
      pushCommits(new Octokit({ auth: githubToken }), internalKey, projectId)
    );

    await step.run("set-completed-status", async () => {
      await convex.mutation(api.system.updateExportStatus, {
        internalKey,
        projectId,
        status: "completed",
        repoUrl: `https://github.com/${result.repo}`,
      });
    });

    return result;
  }
);

async function pushCommits(
  octokit: Octokit,
  internalKey: string,
  projectId: Id<"projects">
) {
  const plan = await convex.query(api.system.getGithubPushPlan, { internalKey, projectId });
  if (!plan) {
    throw new NonRetriableError("Project is not linked to a GitHub repository");
  }
  const sync = plan.githubSync;
  const [owner, repo] = sync.repo.split("/");

  const target = await pushTarget(octokit, owner, repo, sync);

  // The tree of run i is the checkpoint taken before run i + 1; the last
  // run's is the project as it is now, manual edits included.
  const current = await currentFiles(internalKey, projectId);
  const snapshots: { message: string; files: SnapshotFile[] }[] = [];
  for (const [i, run] of plan.runs.entries()) {
    const next = plan.runs[i + 1];
    if (!next) {
      snapshots.push({ message: runMessage(run), files: current });
      break;
    }
    if (plan.more || !next.checkpointId) break;
    snapshots.push({
      message: runMessage(run),
      files: await convex.query(api.system.getCheckpointFilesWithUrls, {
        internalKey,
        projectId,
        checkpointId: next.checkpointId,
      }),
    });
  }

  // History only goes out when every tree in it is complete and clean: the
  // secret check before a push only saw the current files, and a secret an
  // earlier run wrote and a later one removed would still be in history.
  const perRun =
    snapshots.length === plan.runs.length &&
    plan.runs.length > 0 &&
    !(await anySecrets(internalKey, projectId, snapshots.slice(0, -1)));
  let commits = perRun
    ? snapshots
    : [{ message: summaryMessage(plan.runs, plan.more), files: current }];

  let { parent } = target;
  const { data: parentCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: parent,
  });
  const { data: remoteTree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: parentCommit.tree.sha,
    recursive: "true",
  });
  // A truncated listing would hide deletions: write one whole tree instead.
  let base: { tree?: string; blobs: Map<string, string> } = remoteTree.truncated
    ? { blobs: new Map() }
    : {
        tree: parentCommit.tree.sha,
        blobs: new Map(
          remoteTree.tree.flatMap((item) =>
            item.type === "blob" && item.path && item.sha ? [[item.path, item.sha] as const] : []
          )
        ),
      };
  if (remoteTree.truncated) {
    commits = [{ message: summaryMessage(plan.runs, plan.more), files: current }];
  }

  const binaries = new Map<string, { bytes: Buffer; sha: string; uploaded: boolean }>();
  let committed = 0;
  for (const commit of commits) {
    const blobs = new Map<string, string>();
    const changes: {
      path: string;
      mode: "100644";
      type: "blob";
      content?: string;
      sha?: string | null;
    }[] = [];

    for (const file of commit.files) {
      if (file.content !== undefined) {
        const sha = gitBlobSha(Buffer.from(file.content));
        blobs.set(file.path, sha);
        if (base.blobs.get(file.path) !== sha) {
          changes.push({ path: file.path, mode: "100644", type: "blob", content: file.content });
        }
      } else if (file.storageId && file.storageUrl) {
        // shortcut: each push downloads every binary once to hash it; store
        // the SHA on the file if projects with many large assets get slow.
        let binary = binaries.get(file.storageId);
        if (!binary) {
          const bytes = Buffer.from(await (await ky.get(file.storageUrl)).arrayBuffer());
          binary = { bytes, sha: gitBlobSha(bytes), uploaded: false };
          binaries.set(file.storageId, binary);
        }
        blobs.set(file.path, binary.sha);
        if (base.blobs.get(file.path) !== binary.sha) {
          if (!binary.uploaded) {
            await octokit.rest.git.createBlob({
              owner,
              repo,
              content: binary.bytes.toString("base64"),
              encoding: "base64",
            });
            binary.uploaded = true;
          }
          changes.push({ path: file.path, mode: "100644", type: "blob", sha: binary.sha });
        }
      } else {
        // A blob we can't read: leave the remote copy alone, never delete it.
        const kept = base.blobs.get(file.path);
        if (kept) blobs.set(file.path, kept);
      }
    }
    for (const path of base.blobs.keys()) {
      if (!blobs.has(path)) {
        changes.push({ path, mode: "100644", type: "blob", sha: null });
      }
    }
    if (changes.length === 0) continue;

    const { data: tree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: base.tree,
      tree: changes,
    });
    const { data: created } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commit.message,
      tree: tree.sha,
      parents: [parent],
    });
    parent = created.sha;
    base = { tree: tree.sha, blobs };
    committed++;
  }

  if (committed > 0) {
    await moveBranch(octokit, owner, repo, target, parent);
  }

  // shortcut: a crash between moving the branch and saving it here makes the
  // retry see a moved branch and repeat the commits on the sync branch; move
  // both into one idempotent step if that ever shows up.
  await convex.mutation(api.system.setGithubSync, {
    internalKey,
    projectId,
    githubSync:
      target.branch === sync.branch
        ? { repo: sync.repo, branch: sync.branch, lastSyncedSha: parent, lastSyncedAt: plan.planAt }
        : { ...sync, syncBranchSha: parent, syncBranchAt: plan.planAt },
  });

  return { repo: sync.repo, branch: target.branch, commits: committed };
}

/**
 * Where the commits go: the linked branch while it is still where the last
 * sync left it, otherwise GITHUB_SYNC_BRANCH, so nothing on GitHub is lost.
 */
async function pushTarget(octokit: Octokit, owner: string, repo: string, sync: GithubSync) {
  // shortcut: once diverged, pushes keep going to the sync branch until a pull
  // (the next #343 part) moves `lastSyncedSha` to the remote head.
  if (sync.syncBranchSha) {
    const head = await branchHead(octokit, owner, repo, GITHUB_SYNC_BRANCH);
    // Changes made on GitHub would be reverted by our next snapshot.
    if (head && head !== sync.syncBranchSha) {
      throw new NonRetriableError(SYNC_BRANCH_MOVED);
    }
    // Deleted, e.g. after its pull request was merged: recreate it.
    return { branch: GITHUB_SYNC_BRANCH, parent: sync.syncBranchSha, exists: head !== null };
  }
  if ((await branchHead(octokit, owner, repo, sync.branch)) === sync.lastSyncedSha) {
    return { branch: sync.branch, parent: sync.lastSyncedSha, exists: true };
  }
  return { branch: GITHUB_SYNC_BRANCH, parent: sync.lastSyncedSha, exists: false };
}

const SYNC_BRANCH_MOVED =
  `The ${GITHUB_SYNC_BRANCH} branch has commits made on GitHub. ` +
  `Delete the branch (merge its pull request first to keep those changes), then push again.`;

/** The branch's head commit, or null when there is no such branch. */
async function branchHead(octokit: Octokit, owner: string, repo: string, branch: string) {
  try {
    const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return ref.object.sha;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null;
    throw error;
  }
}

/** Fast-forward only. A branch that moved meanwhile fails the attempt. */
async function moveBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  target: { branch: string; exists: boolean },
  sha: string
) {
  if (!target.exists) {
    try {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${target.branch}`, sha });
      return;
    } catch (error) {
      // Left over from an earlier divergence: fast-forward it below.
      if (!(error instanceof RequestError && error.status === 422)) throw error;
    }
  }
  try {
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${target.branch}`, sha, force: false });
  } catch (error) {
    // Not a fast-forward. Retrying re-reads the branch: a linked branch that
    // moved sends the push to the sync branch instead.
    if (error instanceof RequestError && error.status === 422 && target.branch === GITHUB_SYNC_BRANCH) {
      throw new NonRetriableError(SYNC_BRANCH_MOVED);
    }
    throw error;
  }
}

export async function currentFiles(internalKey: string, projectId: Id<"projects">) {
  const files = await convex.query(api.system.getProjectFilesWithUrls, { internalKey, projectId });
  const byId = new Map(files.map((file) => [file._id, file]));
  return files
    .filter((file) => file.type === "file")
    .map((file) => ({ ...file, path: getFilePath(file, byId) }));
}

async function anySecrets(
  internalKey: string,
  projectId: Id<"projects">,
  snapshots: { files: SnapshotFile[] }[]
) {
  if (snapshots.length === 0) return false;
  const env = await storedScanEnv(internalKey, projectId);
  return snapshots.some(({ files }) => {
    const text = files.flatMap(({ path, content }) =>
      content === undefined ? [] : [{ path, content }]
    );
    return scanProject(text, env).length > 0;
  });
}

type PlannedRun = { prompt: string; summary: string };

/** The prompt as the subject, the run's summary as the body. */
export function runMessage({ prompt, summary }: PlannedRun) {
  const subject = prompt.split("\n")[0].trim() || "Agent run in Codenaya";
  return summary.trim() ? `${subject}\n\n${summary.trim()}` : subject;
}

function summaryMessage(runs: PlannedRun[], more: boolean) {
  if (runs.length === 0) return "Manual edits in Codenaya";
  const subjects = runs.map((run) => `- ${runMessage(run).split("\n")[0]}`);
  if (more) subjects.push("- …and more");
  return `Changes from ${more ? "more than " : ""}${runs.length} agent runs in Codenaya\n\n${subjects.join("\n")}`;
}

/** The SHA git gives a blob with these bytes. */
export function gitBlobSha(bytes: Buffer) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
