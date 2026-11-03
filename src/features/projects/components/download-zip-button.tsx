import { DownloadIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SecurityScanDialog } from "@/features/security/components/security-scan-dialog";

import { useDownloadZip } from "../hooks/use-download-zip";

import { Id } from "../../../../convex/_generated/dataModel";

interface DownloadZipButtonProps {
  projectId: Id<"projects">;
}

export const DownloadZipButton = ({ projectId }: DownloadZipButtonProps) => {
  const { download, isDownloading, isBusy, gate } = useDownloadZip(projectId);

  let label = "Download ZIP";
  if (isDownloading) label = "Preparing ZIP...";
  if (gate.checking) label = "Checking for secrets...";

  return (
    <>
      <SecurityScanDialog pending={gate.pending} onDismiss={gate.dismiss} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={isBusy}
        onClick={download}
      >
        {isBusy ? (
          <LoaderIcon className="size-4 animate-spin" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
        {label}
      </Button>
    </>
  );
};
