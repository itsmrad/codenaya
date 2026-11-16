import { v, type Infer } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getSharedProject } from "./projects";
import { validateInternalKey } from "./internalKey";
import { withContents } from "./fileContents";
import { MAX_CHECKPOINT_FILES } from "./checkpoints";
import { isSecretFile } from "./secretFiles";
import { getFilePath } from "../src/features/sandbox-preview/utils/file-tree";
import { MAX_PUBLIC_PREVIEWS, previewDeadline, safePreviewPath } from "../src/features/share/preview-policy";

/** Only Next's server can read the build inputs; no public code or env endpoint. */
export const manifest = query({
  args: { internalKey: v.string(), token: v.string() },
  returns: v.union(v.null(), v.object({
    files: v.array(v.object({ path: v.string(), content: v.union(v.string(), v.null()), url: v.union(v.string(), v.null()) })),
    env: v.record(v.string(), v.string()),
  })),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const project = await getSharedProject(ctx, args.token);
    if (!project) return null;
    let entries;
    if (project.shareMode === "snapshot" && project.shareCheckpointId) {
      const checkpoint = await ctx.db.get("checkpoints", project.shareCheckpointId);
      if (!checkpoint || checkpoint.projectId !== project._id) throw new Error("Shared version unavailable");
      entries = await ctx.db.query("checkpointFiles").withIndex("by_checkpoint_and_path", q => q.eq("checkpointId", checkpoint._id)).take(MAX_CHECKPOINT_FILES + 1);
    } else {
      const files = await ctx.db.query("files").withIndex("by_project", q => q.eq("projectId", project._id)).take(MAX_CHECKPOINT_FILES + 1);
      const byId = new Map(files.map(file => [file._id, file]));
      entries = (await withContents(ctx, project._id, files)).map(file => ({ ...file, path: getFilePath(file, byId) }));
    }
    if (entries.length > MAX_CHECKPOINT_FILES) throw new Error("Project too large to preview");
    const files = await Promise.all(entries.filter(file => file.type === "file" && safePreviewPath(file.path) &&
      !file.path.split("/").some(isSecretFile)).map(async file => ({ path: file.path,
        content: file.storageId ? null : file.content ?? "", url: file.storageId ? await ctx.storage.getUrl(file.storageId) : null })));
    const envRows = await ctx.db.query("projectEnvVars").withIndex("by_project", q => q.eq("projectId", project._id)).take(500);
    const env = Object.fromEntries(envRows.filter(row => row.visibility === "public" && /^(VITE_|NEXT_PUBLIC_)/.test(row.key))
      .map(row => [row.key, row.plainValue ?? ""]));
    return { files, env };
  },
});

const stateResult = v.object({ status: v.union(v.literal("missing"), v.literal("busy"), v.literal("boot"), v.literal("wait"), v.literal("ready"), v.literal("retire"), v.literal("error")),
  failed: v.optional(v.boolean()), desiredRevision: v.optional(v.string()), ready: v.optional(v.boolean()), revision: v.optional(v.string()), sandboxId: v.optional(v.string()), url: v.optional(v.string()), lease: v.optional(v.string()), until: v.optional(v.number()) });

/** Transactional per-link boot lock and owner cap, across all server instances. */
export const claim = mutation({
  args: { internalKey: v.string(), token: v.string(), lease: v.string(), revision: v.optional(v.string()) },
  returns: stateResult,
  handler: async (ctx, args): Promise<Infer<typeof stateResult>> => {
    validateInternalKey(args.internalKey);
    const project = await getSharedProject(ctx, args.token);
    if (!project) return { status: "missing" as const };
    const now = Date.now();
    const active = project.publicPreview;
    if (active && active.until > now) {
      const desired = args.revision ?? active.desiredRevision;
      if (desired && desired !== active.revision) {
        if (active.sandboxId) return { status: "retire" as const, ...active };
        await ctx.db.patch("projects", project._id, { publicPreview: { ...active, desiredRevision: desired } });
      }
      return { status: active.failed ? "error" as const : active.ready ? "ready" as const : "wait" as const, ...active };
    }
    // An expired provider timeout is also proof that the old sandbox no longer counts.
    const owners = await ctx.db.query("projects").withIndex("by_owner", q => q.eq("ownerId", project.ownerId)).take(501);
    if (owners.length > 500 || owners.filter(row => row.publicPreview && row.publicPreview.until > now).length >= MAX_PUBLIC_PREVIEWS) {
      return { status: "busy" as const };
    }
    if (!args.revision) return { status: "boot" as const };
    const preview = { lease: args.lease, revision: args.revision, ready: false, until: previewDeadline(now, project.shareKeepLiveUntil) };
    await ctx.db.patch("projects", project._id, { publicPreview: preview });
    return { status: "boot" as const, ...preview };
  },
});

/** Fenced writes: an old boot or heartbeat cannot overwrite a newer generation. */
export const update = mutation({
  args: { internalKey: v.string(), token: v.string(), lease: v.string(),
    sandboxId: v.optional(v.string()), url: v.optional(v.string()), ready: v.optional(v.boolean()),
    failed: v.optional(v.boolean()), release: v.optional(v.boolean()), heartbeat: v.optional(v.boolean()) },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    validateInternalKey(args.internalKey);
    const project = await getSharedProject(ctx, args.token);
    const active = project?.publicPreview;
    if (!project || !active || active.lease !== args.lease) return null;
    if (args.release) {
      await ctx.db.patch("projects", project._id, { publicPreview: undefined });
      return null;
    }
    const until = args.heartbeat ? previewDeadline(Date.now(), project.shareKeepLiveUntil) : active.until;
    await ctx.db.patch("projects", project._id, { publicPreview: { ...active, until,
      ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}), ...(args.url ? { url: args.url } : {}),
      ...(args.ready !== undefined ? { ready: args.ready } : {}), ...(args.failed ? { failed: true } : {}),
    } });
    return until;
  },
});
