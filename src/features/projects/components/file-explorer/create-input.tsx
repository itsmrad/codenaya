import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";
import { getItemPadding } from "./constants";
import { onEntryKeyDown } from "./input-keys";

export const CreateInput = ({
  type,
  level,
  onSubmit,
  onCancel
}: {
  type: "file" | "folder",
  level: number,
  onSubmit: (name: string, restoreFocus: boolean) => void;
  onCancel: (restoreFocus: boolean) => void;
}) => {
  const [value, setValue] = useState("");

  const handleSubmit = (restoreFocus = false) => {
    const trimmedValue = value.trim();
    if (trimmedValue) {
      onSubmit(trimmedValue, restoreFocus);
    } else {
      onCancel(restoreFocus);
    }
  }

  return (
    <div className="w-full flex items-center gap-1 h-5.5 bg-accent/30"
      style={{ paddingLeft: getItemPadding(level, type === "file") }}
    >
      <div className="flex items-center gap-0.5">
        {type === "folder" && (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        {type === "file" && (
          <FileIcon fileName={value} autoAssign className="size-4" />
        )}
        {type === "folder" && (
          <FolderIcon className="size-4" folderName={value} />
        )}
      </div>
      <input
        autoFocus
        type="text"
        aria-label={`New ${type} name`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="flex-1 bg-transparent text-sm outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
        onBlur={() => handleSubmit()}
        onKeyDown={(e) => onEntryKeyDown(e, handleSubmit, onCancel)}
      />
    </div>
  );
};
