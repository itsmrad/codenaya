import { ListEndIcon, PencilIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** The follow-up waiting for the run to end (#257), above the composer. */
export const QueuedFollowUp = ({
  text,
  onEdit,
  onRemove,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
}) => (
  <div
    role="status"
    className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 py-1 pl-3 pr-1 text-xs"
  >
    <ListEndIcon className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="shrink-0 text-muted-foreground">Queued</span>
    <span className="min-w-0 flex-1 truncate text-foreground/80" title={text}>
      {text}
    </span>
    <Button type="button" size="icon-xs" variant="ghost" aria-label="Edit queued message" onClick={onEdit}>
      <PencilIcon className="size-3" />
    </Button>
    <Button type="button" size="icon-xs" variant="ghost" aria-label="Remove queued message" onClick={onRemove}>
      <XIcon className="size-3" />
    </Button>
  </div>
);
