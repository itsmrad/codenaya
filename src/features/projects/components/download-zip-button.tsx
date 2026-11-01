import React from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { DownloadIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSecurityGate } from "@/features/security/hooks/use-security-gate";
import { SecurityScanDialog } from "@/features/security/components/security-scan-dialog";

import { useProject } from "../hooks/use-projects";
import {
  createProjectZip,
  downloadBlob,
  getZipFileName,
} from "../utils/download-zip";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

interface DownloadZipButtonProps {
  projectId: Id<"projects">;
}

export const DownloadZipButton = ({ projectId }: DownloadZipButtonProps) => {
  const convex = useConvex();
  const project = useProject(projectId);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const gate = useSecurityGate(projectId);

  const handleDownload = async () => {
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

  const isBusy = isDownloading || gate.checking;

  return (
    <>
      <SecurityScanDialog pending={gate.pending} onDismiss={gate.dismiss} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={isBusy}
        onClick={() => gate.guard(handleDownload)}
      >
        {isBusy ? (
          <LoaderIcon className="size-4 animate-spin" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
        {gate.checking
          ? "Checking for secrets..."
          : isDownloading
            ? "Preparing ZIP..."
            : "Download ZIP"}
      </Button>
    </>
  );
};
