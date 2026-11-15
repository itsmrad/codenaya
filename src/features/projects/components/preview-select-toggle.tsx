import { useEffect } from "react";
import { CrosshairIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The preview's Select mode toggle (#227): while on, a click in the app picks
 * an element to attach to the chat message. Only a running app can be picked
 * from; Esc leaves the mode.
 */
export const PreviewSelectToggle = ({
  active,
  disabled,
  onActiveChange,
}: {
  active: boolean;
  disabled: boolean;
  onActiveChange: (active: boolean) => void;
}) => {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onActiveChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onActiveChange]);

  return (
    <Button
      size="icon"
      variant={active ? "secondary" : "ghost"}
      className="size-8 rounded-md hover:bg-muted"
      disabled={disabled}
      onClick={() => onActiveChange(!active)}
      title={
        disabled
          ? "Available once the preview is running"
          : active
            ? "Tab to focus, Enter or Space to select, Esc to stop"
            : "Select an element to attach to the chat"
      }
      aria-label="Select element"
      aria-pressed={active}
    >
      <CrosshairIcon className="size-4" />
    </Button>
  );
};
