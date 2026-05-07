import React from "react";
import { FileIcon } from "@react-symbols/icons/utils";

import { useFilePath } from "@/features/projects/hooks/use-files";
import { useEditor } from "@/features/editor/hooks/use-editor"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

import { Id } from "../../../../convex/_generated/dataModel";

export const FileBreadcrumbs = ({
  projectId,
}: {
  projectId: Id<"projects">;
}) => {
  const { activeTabId } = useEditor(projectId);
  const filePath = useFilePath(activeTabId);

  if (filePath === undefined || !activeTabId) {
    return (
      <div className="px-4 py-2 bg-background border-b border-border/40 flex items-center h-[52px]">
      </div>
    );
  }

  return (
    <div className="px-4 py-2 bg-background border-b border-border/40 flex items-center h-[52px]">
      <div className="flex items-center bg-muted/30 px-3 py-1.5 rounded-lg border border-border/40">
        <Breadcrumb>
          <BreadcrumbList className="sm:gap-1.5 gap-1.5">
            {filePath.map((item, index) => {
              const isLast = index === filePath.length - 1;

              return (
                <React.Fragment key={item._id}>
                  <BreadcrumbItem className="text-sm">
                    {isLast ? (
                      <BreadcrumbPage className="flex items-center gap-1.5 font-medium px-2 py-0.5 bg-muted/50 rounded-md">
                        <FileIcon
                          fileName={item.name}
                          autoAssign
                          className="size-4"
                        />
                        {item.name}
                      </BreadcrumbPage>
                    ) : (
                      <span className="px-2 py-0.5 hover:bg-muted/50 rounded-md transition-colors text-muted-foreground">
                        {item.name}
                      </span>
                    )}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator className="opacity-50" />}
                </React.Fragment>
              )
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </div>
  );
};
