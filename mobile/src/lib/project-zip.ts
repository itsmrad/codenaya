import type { ConvexReactClient } from "convex/react";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import JSZip from "jszip";

import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "@/lib/api";
import { buildPathIndex } from "@/lib/shared";

/** `<project-name>.zip`, same as the web's getZipFileName. */
const zipFileName = (projectName: string) =>
  `${projectName.trim().replace(/[\\/:*?"<>|]/g, "-") || "project"}.zip`;

/**
 * Zips the project like the web's Download ZIP (folders kept, binary files
 * fetched from storage), saves it to the cache and opens the share sheet, where
 * it can be saved to Files or sent on.
 */
export const shareProjectZip = async (
  convex: ConvexReactClient,
  projectId: Id<"projects">,
  projectName: string,
) => {
  const files = await convex.query(api.files.getFilesWithUrls, { projectId });
  const pathOf = buildPathIndex(files);
  const zip = new JSZip();

  await Promise.all(
    files.map(async (file) => {
      const path = pathOf(file._id) ?? file.name;
      if (file.type === "folder") {
        zip.folder(path);
      } else if (file.storageId) {
        if (!file.storageUrl) throw new Error(`Missing stored content for ${path}`);
        const response = await fetch(file.storageUrl);
        if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
        zip.file(path, await response.arrayBuffer(), { binary: true });
      } else {
        zip.file(path, file.content ?? "");
      }
    }),
  );

  const output = new File(Paths.cache, zipFileName(projectName));
  if (output.exists) output.delete();
  output.create();
  output.write(await zip.generateAsync({ type: "uint8array" }));
  await Sharing.shareAsync(output.uri, { mimeType: "application/zip", dialogTitle: zipFileName(projectName) });
};
