import React from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";

import { useSecurityGate } from "@/features/security/hooks/use-security-gate";

import { useProject } from "./use-projects";
import {
  createProjectZip,
  downloadBlob,
  getZipFileName,
} from "../utils/download-zip";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Downloads the project's files as a ZIP, for the Export popover and the
 * palette. Every download passes the secret scan first (#300), so callers
 * render `<SecurityScanDialog>` with the returned `gate`.
 */
export const useDownloadZip = (projectId: Id<"projects">) => {
  const convex = useConvex();
  const project = useProject(projectId);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const gate = useSecurityGate(projectId);
  const isBusy = isDownloading || gate.checking;

  const downloadZip = async () => {
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

  // Skipped while a scan or download is running, so a repeat doesn't start a second one.
  const download = () => (isBusy ? undefined : gate.guard(downloadZip));

  return { download, isDownloading, isBusy, gate };
};
