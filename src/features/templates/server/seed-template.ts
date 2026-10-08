import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getTemplateSeedFiles, planSeedTree } from "../seed-files";
import type { StarterTemplate } from "../templates";

/** Writes a template's seed files into a new, empty project. */
export const seedTemplateFiles = async ({
  internalKey,
  projectId,
  template,
}: {
  internalKey: string;
  projectId: Id<"projects">;
  template: StarterTemplate;
}) => {
  const { folders, filesByFolder } = planSeedTree(getTemplateSeedFiles(template));
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
