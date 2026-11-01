import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { VITE_REACT_STARTER } from "@/features/conversations/inngest/vite-starter";

import { getTemplateSeedFiles, planSeedTree } from "../seed-files";
import type { StarterTemplate } from "../templates";

/**
 * Writes a template's seed files into a new, empty project, or the plain Vite
 * starter without one, so package.json exists before the first run and the
 * preview can start booting at once (#338).
 */
export const seedTemplateFiles = async ({
  internalKey,
  projectId,
  template,
}: {
  internalKey: string;
  projectId: Id<"projects">;
  template?: StarterTemplate;
}) => {
  const { folders, filesByFolder } = planSeedTree(
    template ? getTemplateSeedFiles(template) : [...VITE_REACT_STARTER],
  );
  const folderIds = new Map<string, Id<"files">>();

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

  for (const [folder, files] of filesByFolder) {
    await convex.mutation(api.system.createFiles, {
      internalKey,
      projectId,
      parentId: folderIds.get(folder),
      files,
    });
  }
};
