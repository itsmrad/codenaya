import { HammerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { editedPlanMessage } from "../plan-mode";

interface PlanEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBuild: (message: string) => void;
  onCancel: () => void;
}

/** A plan reply's Markdown, editable before it is built (#527). */
export const PlanEditor = ({ value, onChange, onBuild, onCancel }: PlanEditorProps) => {
  const message = editedPlanMessage(value);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="Edit plan"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
        // Scrolls inside a phone-height panel so the buttons stay in view.
        className="max-h-[50dvh] overflow-y-auto font-mono text-xs md:text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!message}
          onClick={() => message && onBuild(message)}
        >
          <HammerIcon className="size-3.5" />
          Build edited plan
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};
