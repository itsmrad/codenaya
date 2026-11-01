import { z } from "zod";
import { Octokit } from "octokit";
import { NextResponse } from "next/server";
import { requireUserId } from "@/features/auth/server/require-user-id";
import { parseJsonBody } from "@/lib/parse-json-body";

import { inngest } from "@/inngest/client";
import {
  getGithubToken,
  githubNotLinkedResponse,
} from "@/features/projects/server/github-token";
import { requireOwnedProject } from "@/features/projects/server/require-owned-project";
import { currentFiles } from "@/features/projects/inngest/push-to-github";
import { differsFromCommit } from "@/features/projects/inngest/pull-from-github";
import { GITHUB_SYNC_CONFLICT } from "@/features/projects/constants";

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

  const token = await getGithubToken(userId);
  if (!token) {
    return githubNotLinkedResponse();
  }

  const octokit = new Octokit({ auth: token });
  const [owner, repo] = sync.repo.split("/");
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${sync.branch}`,
  });
  const sha = ref.object.sha;

  if (sha === sync.lastSyncedSha) {
    return NextResponse.json({ upToDate: true });
  }

  // Compared with what was last pushed, the sync branch when it was used.
  if (
    !data.overwrite &&
    (await differsFromCommit(
      octokit,
      owner,
      repo,
      sync.syncBranchSha ?? sync.lastSyncedSha,
      await currentFiles(internalKey, project._id)
    ))
  ) {
    return NextResponse.json(
      { error: `${sync.branch} changed on GitHub and here`, code: GITHUB_SYNC_CONFLICT },
      { status: 409 }
    );
  }

  const event = await inngest.send({
    name: "github/sync.pull",
    data: { projectId: project._id, userId, sha },
  });

  return NextResponse.json({ success: true, eventId: event.ids[0] });
}
