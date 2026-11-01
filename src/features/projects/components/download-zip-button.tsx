import { DownloadIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useDownloadZip } from "../hooks/use-download-zip";

import { Id } from "../../../../convex/_generated/dataModel";

interface DownloadZipButtonProps {
  projectId: Id<"projects">;
}

export const DownloadZipButton = ({ projectId }: DownloadZipButtonProps) => {
  const { download: handleDownload, isDownloading } = useDownloadZip(projectId);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="w-full"
      disabled={isDownloading}
      onClick={handleDownload}
    >
      {isDownloading ? (
        <LoaderIcon className="size-4 animate-spin" />
      ) : (
        <DownloadIcon className="size-4" />
      )}
      {isDownloading ? "Preparing ZIP..." : "Download ZIP"}
    </Button>
  );
};
