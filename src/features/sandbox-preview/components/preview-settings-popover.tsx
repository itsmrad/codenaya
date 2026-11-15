"use client";

import { z } from "zod";
import { useMemo, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { SettingsIcon } from "lucide-react";
import { toast } from "sonner";

import { useUpdateProjectSettings } from "@/features/projects/hooks/use-projects";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";

import { buildFlatFileList } from "../utils/file-tree";
import { detectFramework } from "../utils/framework";

import { Doc, Id } from "../../../../convex/_generated/dataModel";

const formSchema = z.object({
  installCommand: z.string(),
  devCommand: z.string(),
});

interface PreviewSettingsPopoverProps {
  projectId: Id<"projects">;
  initialValues?: Doc<"projects">["settings"];
  onSave?: () => void;
  files?: Doc<"files">[];
};

export const PreviewSettingsPopover = ({
  projectId,
  initialValues,
  onSave,
  files,
}: PreviewSettingsPopoverProps) => {
  const framework = useMemo(() => {
    const flatFiles = buildFlatFileList(files ?? []);
    let pkg = null;
    try {
      pkg = JSON.parse(flatFiles.find((file) => file.path === "package.json")?.content ?? "null");
    } catch {
      // A package.json being edited can be temporarily invalid; config paths still work.
    }
    return detectFramework(flatFiles.map((file) => file.path), pkg);
  }, [files]);
  const devPlaceholder = framework === "next" ? "npm run dev -- -H 0.0.0.0"
    : framework === "vite" ? "npm run dev -- --host 0.0.0.0" : "npm run dev";
  const [open, setOpen] = useState(false);
  const updateSettings = useUpdateProjectSettings();

  const form = useForm({
    defaultValues: {
      installCommand: initialValues?.installCommand ?? "",
      devCommand: initialValues?.devCommand ?? "",
    },
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      const trimmedInstall = value.installCommand.trim();
      const trimmedDev = value.devCommand.trim();
      try {
        await updateSettings({
          id: projectId,
          settings: {
            installCommand: trimmedInstall === "" ? undefined : trimmedInstall,
            devCommand: trimmedDev === "" ? undefined : trimmedDev,
          },
        });
      } catch {
        toast.error("Unable to save preview settings. Please try again.");
        return;
      }
      setOpen(false);
      onSave?.();
    }
  });

  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      form.reset({
        installCommand: initialValues?.installCommand ?? "",
        devCommand: initialValues?.devCommand ?? "",
      });
    }
    setOpen(isOpen);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 rounded-md hover:bg-muted"
          title="Preview settings"
          aria-label="Preview settings"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <div className="space-y-4">
            <div className="space-y-1">
              <h4 className="font-medium text-sm">
                Preview Settings
              </h4>
              <p className="text-xs text-muted-foreground">
                Configure how your project runs in the preview.
              </p>
            </div>
            <form.Field name="installCommand">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>
                    Install Command
                  </FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="npm install"
                  />
                  <FieldDescription>
                    Command to install dependencies
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="devCommand">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Start Command</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={devPlaceholder}
                  />
                  <FieldDescription>
                    Command to start the development server{framework ? ` (${framework === "next" ? "Next.js" : "Vite"} detected)` : ""}
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
            >
              {([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? "Saving..." : "Save Changes"}
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
};
