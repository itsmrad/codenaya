import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import { getTemplateSeedFiles, planSeedTree } from "../seed-files";
import type { SeedFile } from "../seed-files";
import type { StarterTemplate } from "../templates";

/**
 * Writes a template's seed files (with an instant template's `source`, #362)
 * into a new, empty project, or the selected starter (Vite by default), so
 * package.json exists before the first run and the preview can start booting
 * at once (#338).
 *
 * Never throws; resolves to false when it stopped partway. A prompt project
 * still has its run, and the agent scaffolds the rest. The root folder goes
 * last, so package.json never lands without the files it boots.
 */
export const seedTemplateFiles = async ({
  internalKey,
  projectId,
  template,
  source,
  starter = VITE_REACT_STARTER,
}: {
  internalKey: string;
  projectId: Id<"projects">;
  template?: StarterTemplate;
  source?: SeedFile[];
  starter?: readonly SeedFile[];
}): Promise<boolean> => {
  const { folders, filesByFolder } = planSeedTree(
    template ? getTemplateSeedFiles(template, source) : [...starter],
  );
  const folderIds = new Map<string, Id<"files">>();
  const batches = [...filesByFolder].sort(([a], [b]) => Number(a === "") - Number(b === ""));

  try {
    for (const path of folders) {
      const parts = path.split("/");
      const name = parts.pop()!;
      const folderId = await convex.mutation(api.system.createFolder, {
        internalKey,
        projectId,
        name,
        parentId: folderIds.get(parts.join("/")),
      });
      folderIds.set(path, folderId);
    }

    for (const [folder, files] of batches) {
      await convex.mutation(api.system.createFiles, {
        internalKey,
        projectId,
        parentId: folderIds.get(folder),
        files,
      });
    }
    return true;
  } catch (error) {
    console.error("[seed-template] seeding stopped partway", error);
    return false;
  }
};
