import { z } from "zod";
import { Octokit, RequestError } from "octokit";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";

import { inngest } from "@/inngest/client";
import { convex } from "@/lib/convex-client";
import {
  getGithubToken,
  githubNotLinkedResponse,
} from "@/features/projects/server/github-token";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import { currentFiles } from "@/features/projects/inngest/push-to-github";
import { differsFromCommit } from "@/features/projects/inngest/pull-from-github";
import { GITHUB_SYNC_CONFLICT } from "@/features/projects/constants";

import { api } from "../../../../../convex/_generated/api";
import type { Doc } from "../../../../../convex/_generated/dataModel";

const requestSchema = z.object({
  projectId: z.string(),
  // Set once the user chose "Overwrite local with GitHub" in the conflict dialog.
  overwrite: z.boolean().optional(),
});

/**
 * POST /api/github/pull: pulls the linked branch into the project (#343).
 * Nothing to do while the branch is where the last sync left it; a 409 when
 * both the branch and the project changed since, unless `overwrite` is set.
 */
export async function POST(request: Request) {
  const { userId, unauthorized } = await requireUserId();

  if (unauthorized) {
    return unauthorized;
  }

  const { data, invalid } = await parseJsonBody(request, requestSchema);

  if (invalid) {
    return invalid;
  }

  const internalKey = process.env.CODENAYA_CONVEX_INTERNAL_KEY;

  if (!internalKey) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const { found: project, notFound } = await requireOwnedProject({
    internalKey,
    userId,
    projectId: data.projectId,
  });

  if (notFound) {
    return notFound;
  }

  const sync = project.githubSync;
  if (!sync) {
    return NextResponse.json(
      { error: "Export this project to GitHub first" },
      { status: 400 }
    );
  }

  // The job refuses too; this says why before anything starts.
  if (await convex.query(api.githubSync.isAgentRunning, { internalKey, projectId: project._id })) {
    return NextResponse.json(
      { error: "Stop the running agent before pulling" },
      { status: 409 }
    );
  }

  const token = await getGithubToken(userId);
  if (!token) {
    return githubNotLinkedResponse();
  }

  const octokit = new Octokit({ auth: token });
  const [owner, repo] = sync.repo.split("/");
  let sha: string;
  let conflict: "unmerged" | "changed" | null = null;
  try {
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${sync.branch}`,
    });
    sha = ref.object.sha;

    if (sha === sync.lastSyncedSha) {
      return NextResponse.json({ upToDate: true });
    }
    if (!data.overwrite) {
      conflict = await pullConflict(octokit, owner, repo, sha, sync, () =>
        currentFiles(internalKey, project._id)
      );
    }
  } catch (error) {
    const response = githubFailure(error, sync);
    if (response) return response;
    throw error;
  }

  if (conflict) {
    return NextResponse.json(
      {
        error: `${sync.branch} changed on GitHub and here`,
        code: GITHUB_SYNC_CONFLICT,
        unmerged: conflict === "unmerged",
      },
      { status: 409 }
    );
  }

  const event = await inngest.send({
    name: "github/sync.pull",
    data: { projectId: project._id, userId, sha },
  });

  return NextResponse.json({ success: true, eventId: event.ids[0] });
}

type GithubSync = NonNullable<Doc<"projects">["githubSync"]>;

/** Why pulling `sha` needs the user's choice first, or null when it doesn't. */
async function pullConflict(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  sync: GithubSync,
  files: () => ReturnType<typeof currentFiles>
) {
  // Changes pushed to the sync branch but not merged yet would be replaced.
  // shortcut: a squash-merged sync branch reads as unmerged; the dialog's
  // overwrite still pulls. Compare trees if that confuses users.
  if (sync.syncBranchSha) {
    const { data: compare } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${sync.syncBranchSha}...${sha}`,
      per_page: 1,
    });
    if (compare.status !== "ahead" && compare.status !== "identical") return "unmerged";
  }
  // Compared with what was last pushed, the sync branch when it was used.
  const changed = await differsFromCommit(
    octokit,
    owner,
    repo,
    sync.syncBranchSha ?? sync.lastSyncedSha,
    await files()
  );
  return changed ? "changed" : null;
}

/** A GitHub API failure as a message the popover shows, or null for anything else. */
function githubFailure(error: unknown, sync: GithubSync) {
  if (!(error instanceof RequestError)) return null;
  const rateLimited =
    error.status === 429 ||
    (error.status === 403 && error.response?.headers["x-ratelimit-remaining"] === "0");
  if (rateLimited) {
    return NextResponse.json(
      { error: "GitHub's rate limit was reached. Try again in a few minutes." },
      { status: 429 }
    );
  }
  if (error.status === 401) {
    return githubNotLinkedResponse(
      "GitHub rejected your sign-in. Reconnect GitHub in your account settings."
    );
  }
  if (error.status === 403 || error.status === 404) {
    return NextResponse.json(
      {
        error: `Couldn't read ${sync.repo} (${sync.branch}) on GitHub. It may have been renamed or deleted, or your account lost access.`,
      },
      { status: error.status }
    );
  }
  return null;
}
