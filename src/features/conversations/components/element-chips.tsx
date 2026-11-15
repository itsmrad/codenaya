import { CrosshairIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { type SelectedElement, elementLabel } from "../selected-elements";

/**
 * Preview elements attached to a message (#227). The label is page content,
 * so it only ever renders as escaped text.
 */
export const ElementChips = ({
  elements,
  onRemove,
  className,
}: {
  elements: (SelectedElement & { key?: string })[];
  /** Given in the composer: each chip gets a remove button. */
  onRemove?: (index: number) => void;
  className?: string;
}) =>
  elements.length > 0 && (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {elements.map((element, index) => (
        <div
          key={element.key ?? index}
          className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
        >
          <CrosshairIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate font-mono" title={element.domPath}>
            {elementLabel(element)}
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${elementLabel(element)}`}
              className="ml-0.5 shrink-0 rounded-full p-0.5 hover:bg-muted-foreground/20"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
