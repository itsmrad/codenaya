"use client";

import { useState, type FormEvent } from "react";
import { CheckIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFile, useUpdateFile } from "@/features/projects/hooks/use-files";
import { cn } from "@/lib/utils";

import type { Id } from "../../../../convex/_generated/dataModel";
import {
  BRAND_COLORS,
  BRAND_FILE,
  BRAND_FILES,
  applyBrandOrNull,
  rewriteCopyPrompt,
  type BrandFiles,
} from "../make-it-mine";

interface MakeItMineCardProps {
  /** The project's file ids by path; the card shows once `src/brand.ts` exists. */
  idOfPath: Map<string, Id<"files">>;
  /** Sends the one short copy-rewrite run. */
  onDescribe: (prompt: string) => void;
}

/**
 * Personalises an instant template (#362): name and colour are written
 * straight into its files with no model run; a description sends one run.
 */
export const MakeItMineCard = ({ idOfPath, onDescribe }: MakeItMineCardProps) => {
  const html = useFile(idOfPath.get("index.html") ?? null);
  const brand = useFile(idOfPath.get(BRAND_FILE) ?? null);
  const css = useFile(idOfPath.get("src/index.css") ?? null);
  const updateFile = useUpdateFile();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>();
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() || color) {
      const current = { "index.html": html, [BRAND_FILE]: brand, "src/index.css": css };
      const files = BRAND_FILES.every((path) => typeof current[path]?.content === "string")
        ? (Object.fromEntries(BRAND_FILES.map((path) => [path, current[path]!.content!])) as BrandFiles)
        : null;
      const next = files && applyBrandOrNull(files, { name, color });
      if (!files || !next) {
        toast.error("This project's brand files were changed, so they can't be updated here. Ask the agent instead.");
        return;
      }
      setSaving(true);
      try {
        // One at a time, so a CONFLICT stops before the next file is written.
        for (const path of BRAND_FILES) {
          if (next[path] === files[path]) continue;
          await updateFile({ id: current[path]!._id, content: next[path], expectedContent: files[path] });
        }
        toast.success("Applied to your app");
      } catch {
        toast.error("Couldn't update the app. Try again.");
        return;
      } finally {
        setSaving(false);
      }
    }
    if (description.trim()) onDescribe(rewriteCopyPrompt(description));
  };

  return (
    <section aria-labelledby="make-it-mine-heading" className="mb-5 rounded-xl border bg-background p-4">
      <h2 id="make-it-mine-heading" className="text-sm font-medium">Make it mine</h2>
      <p className="text-xs text-muted-foreground">
        Your app is ready. Name and colour apply instantly; a description rewrites the copy.
      </p>
      <form onSubmit={handleSubmit} className="mt-3 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="make-it-mine-name">App name</Label>
          <Input id="make-it-mine-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Brand colour</legend>
          <div className="flex flex-wrap gap-2">
            {BRAND_COLORS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                aria-label={preset.name}
                aria-pressed={color === preset.value}
                onClick={() => setColor(color === preset.value ? undefined : preset.value)}
                style={{ backgroundColor: preset.value }}
                className={cn(
                  "grid size-7 place-items-center rounded-full text-white ring-offset-2 ring-offset-background",
                  color === preset.value && "ring-2 ring-foreground",
                )}
              >
                {color === preset.value && <CheckIcon className="size-3.5" />}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor="make-it-mine-description">Your business, in a few words (optional)</Label>
          <Input
            id="make-it-mine-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A bakery in Lisbon"
            maxLength={200}
          />
        </div>
        <Button type="submit" size="sm" disabled={saving || !(name.trim() || color || description.trim())}>
          Apply
        </Button>
      </form>
    </section>
  );
};
