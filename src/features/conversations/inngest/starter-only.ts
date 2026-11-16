import type { Framework } from "@/features/sandbox-preview/utils/framework";

import { buildPathIndex, type PathIndexFile } from "../agent-steps";
import { VITE_REACT_STARTER } from "./vite-starter";
import { NEXT_APP_STARTER, wantsNextJs } from "./next-starter";
import { TANSTACK_START_STARTER, wantsTanStackStart } from "./tanstack-start-starter";

type ProjectFileRow = PathIndexFile & { type: "file" | "folder" };

export const STARTERS: Readonly<Record<Framework, ReadonlyArray<{ path: string; content: string }>>> = {
  vite: VITE_REACT_STARTER,
  next: NEXT_APP_STARTER,
  "tanstack-start": TANSTACK_START_STARTER,
};

/** The framework a prompt names; Start first, since a Start prompt may also say "Vite". */
export const promptFramework = (prompt: string): Framework =>
  wantsTanStackStart(prompt) ? "tanstack-start" : wantsNextJs(prompt) ? "next" : "vite";

/**
 * Which starter's exact file set the project holds, or null for an edited tree.
 */
export const starterFramework = (files: ProjectFileRow[]): Framework | null => {
  const pathOf = buildPathIndex(files);
  const filePaths = new Set(
    files.filter((file) => file.type === "file").map((file) => pathOf(file._id)),
  );
  for (const [framework, starter] of Object.entries(STARTERS) as [Framework, (typeof STARTERS)[Framework]][]) {
    if (filePaths.size === starter.length && starter.every(({ path }) => filePaths.has(path))) {
      return framework;
    }
  }
  return null;
};

export const isStarterOnly = (files: ProjectFileRow[]) => starterFramework(files) !== null;
