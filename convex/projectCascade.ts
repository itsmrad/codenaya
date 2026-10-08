import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Bounded, resumable deletion of everything that hangs off a project.
 *
 * Each call deletes at most one batch of rows from one table and reports
 * whether the project is fully gone. Callers loop by rescheduling themselves
 * (`ctx.scheduler.runAfter(0, ...)`) until it returns `true`, so a project of
 * any size is removed without hitting Convex transaction limits.
 *
 * Shared by account deletion (`users.purgeUserData`) and project deletion, so
 * there is exactly one definition of what "a project's data" means. A table
 * that gains a `projectId` must be added here.
 */

/** Rows deleted per call. Small enough to stay well inside one transaction. */
export const CASCADE_BATCH_SIZE = 100;

/** Deletes the given rows; returns `true` if there were any. */
export async function deleteRows<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  rows: Doc<T>[],
): Promise<boolean> {
  for (const row of rows) {
    await ctx.db.delete(table, row._id);
  }
  return rows.length > 0;
}

/** Deletes a storage blob if it still exists; deleting a missing one throws. */
export async function deleteStorageIfPresent(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) {
  if (await ctx.db.system.get(storageId)) {
    await ctx.storage.delete(storageId);
  }
}

/**
 * One batch of a showcase entry's teardown: votes, then views, then the entry
 * and its preview image. Returns `true` once the entry is gone.
 */
export async function deleteShowcaseBatch(
  ctx: MutationCtx,
  showcase: Doc<"showcaseProjects">,
): Promise<boolean> {
  const votes = await ctx.db
    .query("showcaseVotes")
    .withIndex("by_showcaseProjectId", (q) =>
      q.eq("showcaseProjectId", showcase._id),
    )
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "showcaseVotes", votes)) return false;

  const views = await ctx.db
    .query("showcaseViews")
    .withIndex("by_showcaseProjectId", (q) =>
      q.eq("showcaseProjectId", showcase._id),
    )
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "showcaseViews", views)) return false;

  if (showcase.previewImageId) {
    await deleteStorageIfPresent(ctx, showcase.previewImageId);
  }
  await ctx.db.delete("showcaseProjects", showcase._id);
  return true;
}

/**
 * One batch of a project's teardown, children first so an interrupted run
 * never leaves rows pointing at a deleted project. Returns `true` once the
 * project row itself has been deleted.
 */
export async function deleteProjectBatch(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<boolean> {
  const files = await ctx.db
    .query("files")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  for (const file of files) {
    if (file.storageId) {
      await deleteStorageIfPresent(ctx, file.storageId);
    }
  }
  if (await deleteRows(ctx, "files", files)) return false;

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "messages", messages)) return false;

  const chatImages = await ctx.db
    .query("chatImages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  for (const image of chatImages) {
    await deleteStorageIfPresent(ctx, image.storageId);
  }
  if (await deleteRows(ctx, "chatImages", chatImages)) return false;

  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "conversations", conversations)) return false;

  const envVars = await ctx.db
    .query("projectEnvVars")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "projectEnvVars", envVars)) return false;

  const links = await ctx.db
    .query("projectConnections")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "projectConnections", links)) return false;

  const approvals = await ctx.db
    .query("mcpApprovals")
    .withIndex("by_project_and_status", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "mcpApprovals", approvals)) return false;

  const auditEntries = await ctx.db
    .query("mcpToolAuditLog")
    .withIndex("by_project_and_createdAt", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "mcpToolAuditLog", auditEntries)) return false;

  const skillSettings = await ctx.db
    .query("projectSkillSettings")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "projectSkillSettings", skillSettings)) return false;

  const projectSkills = await ctx.db
    .query("skills")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(CASCADE_BATCH_SIZE);
  if (await deleteRows(ctx, "skills", projectSkills)) return false;

  const showcase = await ctx.db
    .query("showcaseProjects")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .first();
  if (showcase) {
    await deleteShowcaseBatch(ctx, showcase);
    return false;
  }

  await ctx.db.delete("projects", projectId);
  return true;
}
