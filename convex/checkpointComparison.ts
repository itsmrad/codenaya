import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { appError } from "./errors";
import { readFileContent } from "./fileContents";
import { findSibling } from "./files";

// shortcut: refuse larger comparisons whole; paginate metadata/digests if larger projects need them.
export const MAX_COMPARISON_ENTRIES = 200;
export const MAX_COMPARISON_BYTES = 4 * 1024 * 1024;

type State = Pick<Doc<"checkpointFiles">, "content" | "storageId">;

export function validateComparisonPath(path: string) {
  const segments = path.split("/");
  if (path.length > 4096 || segments.length > 100 || segments.some((part) => !part || part === "." || part === "..")) {
    throw appError("INVALID_ARGUMENT", "Choose a valid project file path");
  }
  return segments;
}

/** Resolve one path with indexed sibling lookups, without reading unrelated files. */
async function liveFileAt(ctx: QueryCtx, projectId: Id<"projects">, path: string) {
  const segments = validateComparisonPath(path);
  let parentId: Id<"files"> | undefined;
  for (const [index, name] of segments.entries()) {
    const file = await findSibling(ctx, {
      projectId, parentId, name, type: index === segments.length - 1 ? "file" : "folder",
    });
    if (!file) return null;
    if (index === segments.length - 1) return file;
    parentId = file._id;
  }
  return null;
}

const stateOf = async (ctx: QueryCtx, file: Doc<"files">): Promise<State> => ({
  content: file.storageId ? undefined : (await readFileContent(ctx, file)) ?? "",
  storageId: file.storageId,
});

/** Current project versus a snapshot, including edits outside agent-written paths. */
export async function projectChanges(ctx: QueryCtx, checkpoint: Doc<"checkpoints">, only?: string) {
  const before = new Map<string, State>();
  const after = new Map<string, State>();
  if (only !== undefined) {
    validateComparisonPath(only);
    const rows = await ctx.db.query("checkpointFiles")
      .withIndex("by_checkpoint_and_path", (q) => q.eq("checkpointId", checkpoint._id).eq("path", only))
      .take(2);
    const row = rows.find((row) => row.type === "file");
    if (row) before.set(only, { content: row.storageId ? undefined : row.content ?? "", storageId: row.storageId });
    const live = await liveFileAt(ctx, checkpoint.projectId, only);
    if (live) after.set(only, await stateOf(ctx, live));
  } else {
    // Stream with entry + byte caps: never return a partial comparison. A read
    // can overshoot by one <=1 MiB row; both sides stay below Convex's 16 MiB.
    let bytes = 0;
    let entries = 0;
    const encodedSize = (row: object) => new TextEncoder().encode(JSON.stringify(row)).byteLength;
    for await (const row of ctx.db.query("checkpointFiles")
      .withIndex("by_checkpoint_and_path", (q) => q.eq("checkpointId", checkpoint._id))) {
      bytes += encodedSize(row);
      if (++entries > MAX_COMPARISON_ENTRIES || bytes > MAX_COMPARISON_BYTES) return null;
      if (row.type === "file") before.set(row.path, { content: row.storageId ? undefined : row.content ?? "", storageId: row.storageId });
    }
    bytes = 0;
    const live: Doc<"files">[] = [];
    for await (const file of ctx.db.query("files")
      .withIndex("by_project", (q) => q.eq("projectId", checkpoint.projectId))) {
      bytes += encodedSize(file);
      if (live.length === MAX_COMPARISON_ENTRIES || bytes > MAX_COMPARISON_BYTES) return null;
      live.push(file);
    }
    const byId = new Map(live.map((file) => [file._id, file]));
    const pathOf = (file: Doc<"files">): string => {
      const parent = file.parentId && byId.get(file.parentId);
      return parent ? `${pathOf(parent)}/${file.name}` : file.name;
    };
    for (const file of live) {
      if (file.type !== "file") continue;
      const state = await stateOf(ctx, file);
      bytes += new TextEncoder().encode(state.content ?? "").byteLength;
      if (bytes > MAX_COMPARISON_BYTES) return null;
      after.set(pathOf(file), state);
    }
  }
  return [...new Set([...before.keys(), ...after.keys()])].sort()
    .map((path) => ({ path, before: before.get(path), after: after.get(path) }))
    .filter(({ before, after }) => !before || !after || before.content !== after.content || before.storageId !== after.storageId);
}
