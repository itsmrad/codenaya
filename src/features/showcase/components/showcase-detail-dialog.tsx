"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

import type { ShowcaseProject } from "../types";
import { ShowcaseDetail } from "./showcase-detail";

interface ShowcaseDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ShowcaseProject | null;
}

export const ShowcaseDetailDialog = ({
  open,
  onOpenChange,
  project,
}: ShowcaseDetailDialogProps) => {
  if (!project) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto p-0">
        <ShowcaseDetail project={project} TitleAs={DialogTitle} />
      </DialogContent>
    </Dialog>
  );
};
