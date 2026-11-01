import React from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";

import { useProject } from "./use-projects";
import {
  createProjectZip,
  downloadBlob,
  getZipFileName,
} from "../utils/download-zip";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/** Downloads the project's files as a ZIP, for the Export popover and the palette. */
export const useDownloadZip = (projectId: Id<"projects">) => {
  const convex = useConvex();
  const project = useProject(projectId);
  const [isDownloading, setIsDownloading] = React.useState(false);

  const download = async () => {
    setIsDownloading(true);
    try {
      const files = await convex.query(api.files.getFilesWithUrls, {
        projectId,
      });
      const zip = await createProjectZip(files);
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, getZipFileName(project?.name ?? ""));
    } catch {
      toast.error("Unable to download ZIP");
    } finally {
      setIsDownloading(false);
    }
  };

  return { download, isDownloading };
};
