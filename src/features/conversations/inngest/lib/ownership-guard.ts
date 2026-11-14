import type { Tool } from "@inngest/agent-kit";
import { ownsPath } from "../../swarm";

/** Refuse the whole write before calling the underlying tool, including legacy id inputs. */
export const guardOwnedPaths = (ownedPaths: readonly string[]) => (tool: Tool.Any): Tool.Any => ({
  ...tool,
  handler: (input, opts) => {
    const params = input as Record<string, unknown>;
    let paths: unknown[];
    switch (tool.name) {
      case "writeFiles":
        paths = Array.isArray(params?.files)
          ? params.files.map((file) => (file as { path?: unknown } | null)?.path) : [];
        break;
      case "editFile": paths = [params?.path]; break;
      case "deleteFiles": paths = Array.isArray(params?.paths) ? params.paths : []; break;
      default: return tool.handler(input, opts);
    }
    if (!paths.length || paths.some((path) => typeof path !== "string" || !ownsPath(ownedPaths, path))) {
      return "Error: Write refused. Use only your owned paths; ask the orchestrator for shared or outside changes in NEEDS:.";
    }
    return tool.handler(input, opts);
  },
});
