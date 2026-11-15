import type { Tool } from "@inngest/agent-kit";
import { FOUNDATION_PLACEHOLDER_MAX_CHARS, isFoundationPath, ownsPath } from "../../swarm";

/** The paths a path-based write acts on; undefined for a tool that writes no file paths. */
const writePaths = (name: string, params: Record<string, unknown> | undefined): unknown[] | undefined => {
  switch (name) {
    case "writeFiles":
      return Array.isArray(params?.files) ? params.files.map((file) => (file as { path?: unknown } | null)?.path) : [];
    case "editFile":
    case "updateFile": return [params?.path];
    case "deleteFiles": return Array.isArray(params?.paths) ? params.paths : [];
  }
};

/** Refuse the whole write before calling the underlying tool, including legacy id inputs. */
export const guardOwnedPaths = (ownedPaths: readonly string[]) => (tool: Tool.Any): Tool.Any => ({
  ...tool,
  handler: (input, opts) => {
    const paths = writePaths(tool.name, input as Record<string, unknown>);
    if (!paths) return tool.handler(input, opts);
    if (!paths.length || paths.some((path) => typeof path !== "string" || !ownsPath(ownedPaths, path))) {
      return "Error: Write refused. Use only your owned paths; ask the orchestrator for shared or outside changes in NEEDS:.";
    }
    return tool.handler(input, opts);
  },
});

/** Every foundation refusal starts with this, so the swarm gate can see one and force delegateTasks. */
export const FOUNDATION_REFUSAL = "Error: Swarm mode:";
/** Writes that name files by id or folder, which the foundation guard cannot judge. */
const ID_WRITE_TOOLS = new Set(["createFiles", "renameFile"]);

/**
 * A swarm orchestrator before delegation (`open` false): it writes only the shared foundation
 * (`isFoundationPath`) and one-line page placeholders, which the owning worker overwrites.
 */
export const guardFoundation = (open: () => boolean) => (tool: Tool.Any): Tool.Any => ({
  ...tool,
  handler: (input, opts) => {
    if (open()) return tool.handler(input, opts);
    if (ID_WRITE_TOOLS.has(tool.name)) {
      return `${FOUNDATION_REFUSAL} before delegateTasks, write the shared foundation with writeFiles or editFile.`;
    }
    const params = input as Record<string, unknown>;
    const paths = writePaths(tool.name, params);
    if (!paths) return tool.handler(input, opts);
    const files = tool.name === "writeFiles" && Array.isArray(params?.files) ? params.files as Array<{ content?: unknown } | null> : [];
    const placeholder = (i: number) => {
      const content = files[i]?.content;
      return typeof content === "string" && content.length <= FOUNDATION_PLACEHOLDER_MAX_CHARS;
    };
    const blocked = paths.find((path, i) => typeof path !== "string" || !(isFoundationPath(path) || placeholder(i)));
    if (blocked !== undefined) {
      return `${FOUNDATION_REFUSAL} ${String(blocked)} belongs to a worker. Call delegateTasks now with 2-4 tasks that own it.`;
    }
    return tool.handler(input, opts);
  },
});
