import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
  kyGet: vi.fn(),
  github: {} as Record<string, (args: never) => unknown>,
}));

vi.mock("@/lib/convex-client", () => ({
  convex: { query: mocks.query, mutation: mocks.mutation },
}));
vi.mock("@/features/projects/server/github-token", () => ({
  requireJobGithubToken: async () => "gho_test",
}));
vi.mock("@/features/security/server/scan-stored-project", () => ({
  storedScanEnv: async () => [],
}));
vi.mock("ky", () => ({ default: { get: mocks.kyGet } }));
vi.mock("octokit", () => ({
  RequestError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  Octokit: class {
    rest = { git: mocks.github };
  },
}));
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: object) => Object.assign(handler, { config }),
  },
}));

import { RequestError } from "octokit";
import { gitBlobSha, pushToGithub } from "./push-to-github";

/** A small in-memory GitHub: commits, trees as path → blob SHA, and refs. */
function fakeGithub(files: Record<string, string>) {
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  let n = 0;
  const addTree = (blobs: Map<string, string>) => {
    const sha = `tree${n++}`;
    trees.set(sha, blobs);
    return sha;
  };
  const sha = (text: string) => gitBlobSha(Buffer.from(text));
  const root = "c0";
  commits.set(root, {
    tree: addTree(new Map(Object.entries(files).map(([path, text]) => [path, sha(text)]))),
    parents: [],
    message: "Initial commit from Codenaya",
  });
  refs.set("main", root);

  const isAncestor = (ancestor: string, of: string): boolean =>
    ancestor === of || (commits.get(of)?.parents ?? []).some((p) => isAncestor(ancestor, p));

  type Change = { path: string; content?: string; sha?: string | null };
  mocks.github = {
    getRef: ({ ref }: { ref: string }) => {
      const head = refs.get(ref.replace("heads/", ""));
      if (!head) throw new RequestError("Not Found", 404, {} as never);
      return { data: { object: { sha: head } } };
    },
    getCommit: ({ commit_sha }: { commit_sha: string }) => ({
      data: { tree: { sha: commits.get(commit_sha)!.tree } },
    }),
    getTree: vi.fn(({ tree_sha }: { tree_sha: string }) => ({
      data: {
        tree: [...trees.get(tree_sha)!].map(([path, sha]) => ({ path, sha, type: "blob" })),
        truncated: false,
      },
    })),
    createBlob: vi.fn(() => ({ data: { sha: "unused" } })),
    createTree: vi.fn(({ base_tree, tree }: { base_tree?: string; tree: Change[] }) => {
      const blobs = new Map(base_tree ? trees.get(base_tree) : []);
      for (const change of tree) {
        if (change.content !== undefined) blobs.set(change.path, sha(change.content));
        else if (change.sha === null) blobs.delete(change.path);
        else blobs.set(change.path, change.sha!);
      }
      return { data: { sha: addTree(blobs) } };
    }),
    createCommit: ({ tree, parents, message }: { tree: string; parents: string[]; message: string }) => {
      const commitSha = `c${commits.size}`;
      commits.set(commitSha, { tree, parents, message });
      return { data: { sha: commitSha } };
    },
    createRef: vi.fn(({ ref, sha: target }: { ref: string; sha: string }) => {
      const branch = ref.replace("refs/heads/", "");
      if (refs.has(branch)) throw new RequestError("Reference already exists", 422, {} as never);
      refs.set(branch, target);
    }),
    updateRef: vi.fn(({ ref, sha: target, force }: { ref: string; sha: string; force?: boolean }) => {
      const branch = ref.replace("heads/", "");
      if (force || !isAncestor(refs.get(branch)!, target)) {
        throw new RequestError("Update is not a fast forward", 422, {} as never);
      }
      refs.set(branch, target);
    }),
  } as typeof mocks.github;

  /** The branch's commits after the initial one, oldest first, with their files. */
  const log = (branch: string) => {
    const out: { message: string; files: Record<string, string> }[] = [];
    for (let c = refs.get(branch); c && c !== root; c = commits.get(c)!.parents[0]) {
      const commit = commits.get(c)!;
      out.unshift({
        message: commit.message,
        files: Object.fromEntries([...trees.get(commit.tree)!].sort()),
      });
    }
    return out;
  };

  /** Someone pushes to the branch from elsewhere. */
  const pushElsewhere = (branch: string, sha = "elsewhere") => {
    const head = refs.get(branch)!;
    commits.set(sha, { tree: commits.get(head)!.tree, parents: [head], message: "From Cursor" });
    refs.set(branch, sha);
  };

  return { refs, log, sha, pushElsewhere };
}

const PLAN_AT = 5000;

const LINKED = { repo: "octocat/demo", branch: "main", lastSyncedSha: "c0", lastSyncedAt: 100 };

type Run = { prompt: string; summary: string; checkpointId: string | null };

/** Convex as the job reads it: the plan, checkpoints by id and the current files. */
function project(opts: {
  runs: Run[];
  checkpoints?: Record<string, Record<string, string>>;
  files: Record<string, string>;
  githubSync?: object;
  more?: boolean;
}) {
  mocks.query.mockImplementation(async (ref, args) => {
    switch (getFunctionName(ref)) {
      case "system:getGithubPushPlan":
        return {
          githubSync: opts.githubSync ?? LINKED,
          planAt: PLAN_AT,
          more: opts.more ?? false,
          runs: opts.runs.map((run, i) => ({ messageId: `m${i}`, createdAt: 200 + i, ...run })),
        };
      case "system:getCheckpointFilesWithUrls":
        return Object.entries(opts.checkpoints![args.checkpointId]).map(([path, content]) => ({
          path,
          type: "file",
          content,
          storageUrl: null,
        }));
      case "system:getProjectFilesWithUrls":
        return Object.entries(opts.files).map(([name, content]) => ({
          _id: name,
          name,
          type: "file",
          content,
          storageUrl: null,
        }));
    }
    throw new Error(`unexpected query ${getFunctionName(ref)}`);
  });
}

const runJob = () =>
  (pushToGithub as unknown as (ctx: unknown) => Promise<unknown>)({
    event: { data: { projectId: "p1", userId: "user_1" } },
    step: { run: (_name: string, fn: () => unknown) => fn() },
  });

const savedSync = () =>
  mocks.mutation.mock.calls.find(([ref]) => getFunctionName(ref) === "system:setGithubSync")?.[1]
    .githubSync;

describe("pushToGithub (#343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  });

  it("makes one commit per run, oldest first, and fast-forwards the branch", async () => {
    const gh = fakeGithub({ "index.html": "v1", "old.txt": "bye" });
    project({
      runs: [
        { prompt: "Make it blue\nand round", summary: "- Blue button", checkpointId: null },
        { prompt: "Add a footer", summary: "- Footer", checkpointId: "cp2" },
      ],
      // Taken before the second run: the first run's result.
      checkpoints: { cp2: { "index.html": "v2 blue" } },
      files: { "index.html": "v2 blue", "footer.html": "<footer>" },
    });

    await expect(runJob()).resolves.toEqual({ repo: "octocat/demo", branch: "main", commits: 2 });

    expect(gh.log("main")).toEqual([
      { message: "Make it blue\n\n- Blue button", files: { "index.html": gh.sha("v2 blue") } },
      {
        message: "Add a footer\n\n- Footer",
        files: { "footer.html": gh.sha("<footer>"), "index.html": gh.sha("v2 blue") },
      },
    ]);
    // Only what changed is sent; unchanged files come from the base tree.
    const sent = vi.mocked(mocks.github.createTree).mock.calls.map(([args]) =>
      (args as { tree: { path: string }[] }).tree.map((change) => change.path)
    );
    expect(sent).toEqual([["index.html", "old.txt"], ["footer.html"]]);
    // The sync time comes from Convex's clock, not this server's.
    expect(savedSync()).toEqual({ ...LINKED, lastSyncedSha: gh.refs.get("main"), lastSyncedAt: PLAN_AT });
    const statuses = mocks.mutation.mock.calls
      .filter(([ref]) => getFunctionName(ref) === "system:updateExportStatus")
      .map(([, args]) => args.status);
    expect(statuses).toEqual(["exporting", "completed"]);
  });

  it("pushes to codenaya-sync when the branch moved elsewhere, and keeps going there", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    gh.pushElsewhere("main");
    project({ runs: [{ prompt: "Edit", summary: "", checkpointId: null }], files: { "index.html": "v2" } });

    await expect(runJob()).resolves.toMatchObject({ branch: "codenaya-sync", commits: 1 });

    expect(gh.refs.get("main")).toBe("elsewhere");
    expect(gh.log("codenaya-sync")).toEqual([{ message: "Edit", files: { "index.html": gh.sha("v2") } }]);
    const diverged = savedSync();
    expect(diverged).toMatchObject({ ...LINKED, syncBranchSha: gh.refs.get("codenaya-sync") });

    // The next push builds on the sync branch, by fast-forward.
    mocks.mutation.mockClear();
    project({
      runs: [{ prompt: "Again", summary: "", checkpointId: "cp" }],
      files: { "index.html": "v3" },
      githubSync: diverged,
    });
    await expect(runJob()).resolves.toMatchObject({ branch: "codenaya-sync", commits: 1 });
    expect(gh.log("codenaya-sync").map((c) => c.message)).toEqual(["Edit", "Again"]);
  });

  it("retries a branch that moved mid-push on the sync branch", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    project({ runs: [{ prompt: "Edit", summary: "", checkpointId: null }], files: { "index.html": "v2" } });
    const getRef = mocks.github.getRef;
    // GitHub reports the old head, then someone pushes before the ref moves.
    mocks.github.getRef = ((args: never) => {
      const result = getRef(args);
      gh.pushElsewhere("main");
      mocks.github.getRef = getRef;
      return result;
    }) as never;

    await expect(runJob()).rejects.toThrow("not a fast forward");
    await expect(runJob()).resolves.toMatchObject({ branch: "codenaya-sync" });
    expect(gh.refs.get("main")).toBe("elsewhere");
  });

  it("recreates a deleted sync branch on the next push", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    gh.pushElsewhere("main");
    project({ runs: [{ prompt: "Edit", summary: "", checkpointId: null }], files: { "index.html": "v2" } });
    await runJob();
    const diverged = savedSync();
    // Its pull request was merged and the branch deleted.
    gh.refs.delete("codenaya-sync");

    mocks.mutation.mockClear();
    project({ runs: [{ prompt: "Again", summary: "", checkpointId: null }], files: { "index.html": "v3" }, githubSync: diverged });
    await expect(runJob()).resolves.toMatchObject({ branch: "codenaya-sync", commits: 1 });

    expect(gh.log("codenaya-sync").map((c) => c.message)).toEqual(["Edit", "Again"]);
    expect(mocks.github.updateRef).not.toHaveBeenCalled();
  });

  it("stops with a clear message when the sync branch has commits made on GitHub", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    gh.pushElsewhere("main");
    project({ runs: [{ prompt: "Edit", summary: "", checkpointId: null }], files: { "index.html": "v2" } });
    await runJob();
    const diverged = savedSync();
    // "Resolve conflicts" on GitHub adds a merge commit to it.
    gh.pushElsewhere("codenaya-sync", "conflict-fix");

    vi.clearAllMocks();
    project({ runs: [{ prompt: "Again", summary: "", checkpointId: null }], files: { "index.html": "v3" }, githubSync: diverged });
    await expect(runJob()).rejects.toThrow(/codenaya-sync branch has commits made on GitHub\. Merge its pull request or delete the branch/);

    expect(gh.refs.get("codenaya-sync")).toBe("conflict-fix");
    expect(mocks.github.createTree).not.toHaveBeenCalled();
  });

  it("falls back to one commit listing the runs when a checkpoint is gone", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    project({
      runs: [
        { prompt: "One", summary: "", checkpointId: null },
        { prompt: "Two", summary: "", checkpointId: null },
      ],
      files: { "index.html": "v3" },
    });

    await expect(runJob()).resolves.toMatchObject({ commits: 1 });

    expect(gh.log("main")).toEqual([
      {
        message: "Changes from 2 agent runs in Codenaya\n\n- One\n- Two",
        files: { "index.html": gh.sha("v3") },
      },
    ]);
  });

  it("keeps a secret an earlier run wrote and a later one removed out of history", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    project({
      runs: [
        { prompt: "Hard-code the key", summary: "", checkpointId: null },
        { prompt: "Use an env var", summary: "", checkpointId: "cp2" },
      ],
      checkpoints: { cp2: { "index.html": `const key = "ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4"}";` } },
      files: { "index.html": "const key = process.env.KEY;" },
    });

    await runJob();

    expect(gh.log("main")).toEqual([
      {
        message: expect.stringMatching(/^Changes from 2 agent runs/),
        files: { "index.html": gh.sha("const key = process.env.KEY;") },
      },
    ]);
  });

  it("commits manual edits without runs, and moves nothing when nothing changed", async () => {
    const gh = fakeGithub({ "index.html": "v1" });
    project({ runs: [], files: { "index.html": "by hand" } });

    await runJob();
    expect(gh.log("main").map((c) => c.message)).toEqual(["Manual edits in Codenaya"]);

    const githubSync = savedSync();
    vi.clearAllMocks();
    project({ runs: [], files: { "index.html": "by hand" }, githubSync });
    const head = gh.refs.get("main");
    await expect(runJob()).resolves.toMatchObject({ commits: 0 });
    expect(gh.refs.get("main")).toBe(head);
    expect(mocks.github.updateRef).not.toHaveBeenCalled();
  });

  it("never deletes a binary it could not read", async () => {
    const gh = fakeGithub({ "index.html": "v1", "logo.png": "old bytes" });
    mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getGithubPushPlan"
        ? { githubSync: LINKED, planAt: PLAN_AT, more: false, runs: [] }
        : [
            { _id: "a", name: "index.html", type: "file", content: "v2" },
            { _id: "b", name: "logo.png", type: "file", storageId: "s1", storageUrl: null },
          ]
    );

    await runJob();

    expect(gh.log("main")[0].files).toEqual({ "index.html": gh.sha("v2"), "logo.png": gh.sha("old bytes") });
  });

  it("writes one whole tree when GitHub truncates the tree listing", async () => {
    const gh = fakeGithub({ "index.html": "v1", "gone.txt": "bye" });
    const getTree = mocks.github.getTree;
    mocks.github.getTree = ((args: never) => {
      const { data } = getTree(args) as { data: { tree: { path: string }[] } };
      // GitHub lists only part of the tree.
      return { data: { tree: data.tree.slice(0, 1), truncated: true } };
    }) as never;
    project({
      runs: [
        { prompt: "One", summary: "", checkpointId: null },
        { prompt: "Two", summary: "", checkpointId: "cp2" },
      ],
      checkpoints: { cp2: { "index.html": "v2" } },
      files: { "index.html": "v3" },
    });

    await runJob();

    expect(gh.log("main")).toEqual([
      { message: expect.stringMatching(/^Changes from 2 agent runs/), files: { "index.html": gh.sha("v3") } },
    ]);
    expect(vi.mocked(mocks.github.createTree).mock.calls[0][0]).toMatchObject({ base_tree: undefined });
  });

  it("downloads and uploads a binary used at two paths once", async () => {
    const png = Buffer.from([0x89, 0x50, 0x00]);
    const gh = fakeGithub({ "index.html": "v1" });
    mocks.kyGet.mockResolvedValue({ arrayBuffer: async () => Uint8Array.from(png).buffer });
    mocks.query.mockImplementation(async (ref) =>
      getFunctionName(ref) === "system:getGithubPushPlan"
        ? { githubSync: LINKED, planAt: PLAN_AT, more: false, runs: [] }
        : [
            { _id: "a", name: "logo.png", type: "file", storageId: "s1", storageUrl: "https://storage/a" },
            { _id: "b", name: "copy.png", type: "file", storageId: "s1", storageUrl: "https://storage/a" },
          ]
    );

    await runJob();

    expect(mocks.kyGet).toHaveBeenCalledTimes(1);
    expect(mocks.github.createBlob).toHaveBeenCalledTimes(1);
    expect(gh.log("main")[0].files).toEqual({ "copy.png": gitBlobSha(png), "logo.png": gitBlobSha(png) });
  });
});

describe("pushToGithub onFailure", () => {
  const onFailure = (error: Error) =>
    (pushToGithub as unknown as { config: { onFailure: (ctx: unknown) => Promise<void> } }).config.onFailure({
      event: { data: { event: { data: { projectId: "p1" } } } },
      error,
      step: { run: (_name: string, fn: () => unknown) => fn() },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CODENAYA_CONVEX_INTERNAL_KEY", "test-key");
  });

  it("shows the user why a push stopped", async () => {
    const error = Object.assign(new Error("Merge its pull request"), { name: "NonRetriableError" });
    await onFailure(error);

    expect(mocks.mutation.mock.calls[0][1]).toEqual({
      internalKey: "test-key",
      projectId: "p1",
      status: "failed",
      error: "Merge its pull request",
    });
  });

  it("keeps other errors out of the UI", async () => {
    await onFailure(new Error("socket hang up"));

    expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ status: "failed", error: undefined });
  });
});

describe("GitHub pushes", () => {
  it("never force-push anywhere in the app", () => {
    const root = join(process.cwd(), "src");
    const offenders = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .filter((path) => /force:\s*true/.test(readFileSync(join(root, path), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("hashes blobs the way git does", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
