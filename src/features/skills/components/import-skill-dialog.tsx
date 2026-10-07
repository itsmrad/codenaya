"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeftIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import type { SkillFields } from "../limits";
import { skillErrorMessage, useCreateSkill } from "../hooks/use-skills";
import { SkillMarkdown } from "./skill-markdown";

type ImportedSkill = SkillFields & { sourceUrl: string };

interface ImportSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Imports a SKILL.md from GitHub or skills.sh into the user's library. The
 * skill is third-party text, so it is previewed and saved only on confirm.
 */
export const ImportSkillDialog = ({ open, onOpenChange }: ImportSkillDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Import a skill</DialogTitle>
        <DialogDescription>
          Paste a GitHub folder that contains a SKILL.md, or a skills.sh skill
          page. Only the SKILL.md text is imported; scripts and other files are
          ignored.
        </DialogDescription>
      </DialogHeader>
      {/* Remounts on open so each import starts from an empty form. */}
      {open && <ImportSkillForm onDone={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>
);

const ImportSkillForm = ({ onDone }: { onDone: () => void }) => {
  const createSkill = useCreateSkill();

  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportedSkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handlePreview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) {
      setError("Paste a GitHub or skills.sh URL");
      return;
    }

    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json().catch(() => null)) as
        | { skill?: ImportedSkill; error?: string }
        | null;
      if (!response.ok || !data?.skill) {
        setError(data?.error ?? "Unable to import the skill");
        return;
      }
      setPreview(data.skill);
    } catch {
      setError("Unable to reach the server. Check your connection.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    setError(null);
    setIsLoading(true);
    try {
      await createSkill(preview);
      toast.success(`Imported ${preview.name}`);
      onDone();
    } catch (saveError) {
      setError(skillErrorMessage(saveError, "Unable to save the skill"));
    } finally {
      setIsLoading(false);
    }
  };

  if (preview) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <Alert>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            This skill was written by a third party. Read it before saving: the
            agent follows it when a task matches its description.
          </AlertDescription>
        </Alert>

        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-mono text-sm font-medium">
              {preview.name}
            </h3>
            <Badge variant="secondary">GitHub</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{preview.description}</p>
          <a
            href={preview.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            <span className="truncate">{preview.sourceUrl}</span>
            <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
          </a>
        </div>

        <div
          aria-label="Skill instructions"
          className="h-64 overflow-y-auto rounded-md border bg-muted/20 px-3 py-2"
        >
          {preview.body ? (
            <SkillMarkdown>{preview.body}</SkillMarkdown>
          ) : (
            <p className="text-xs text-muted-foreground">No instructions.</p>
          )}
        </div>

        {error && <FieldError>{error}</FieldError>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => {
              setPreview(null);
              setError(null);
            }}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Back
          </Button>
          <Button type="button" disabled={isLoading} onClick={handleSave}>
            {isLoading && <Spinner />}
            Save to my library
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={handlePreview} className="flex min-w-0 flex-col gap-4">
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="skill-import-url">Skill URL</FieldLabel>
        <Input
          id="skill-import-url"
          type="text"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={Boolean(error)}
          placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <FieldDescription>
            Also accepts owner/repo/path and https://skills.sh/owner/repo/skill.
          </FieldDescription>
        )}
      </Field>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {isLoading && <Spinner />}
          Preview
        </Button>
      </DialogFooter>
    </form>
  );
};
