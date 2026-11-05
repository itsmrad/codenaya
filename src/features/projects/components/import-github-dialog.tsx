import { useState } from "react";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useForm } from "@tanstack/react-form";
import { FaGithub } from "react-icons/fa";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

import { GITHUB_NOT_LINKED } from "../constants";
import { parseGithubRepo } from "../utils/github-repo";
import { GithubNotLinkedAlert } from "./github-not-linked-alert";

import { Id } from "../../../../convex/_generated/dataModel";

const formSchema = z.object({
  url: z
    .url({ message: "Please enter a valid URL", abort: true })
    .refine((url) => parseGithubRepo(url) !== null, "Enter a GitHub repository URL like https://github.com/owner/repo"),
});

interface ImportGithubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefills the URL field, e.g. from an "Open in Codenaya" link. */
  defaultUrl?: string;
}

export const ImportGithubDialog = ({
  open,
  onOpenChange,
  defaultUrl = "",
}: ImportGithubDialogProps) => {
  const router = useRouter();
  const [githubNotLinked, setGithubNotLinked] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setGithubNotLinked(false);
    }
    onOpenChange(nextOpen);
  };

  const form = useForm({
    defaultValues: {
      url: defaultUrl,
    },
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      setGithubNotLinked(false);
      try {
        const { projectId } = await ky
          .post("/api/github/import", {
            json: { url: value.url },
          })
          .json<{ 
            success: boolean; 
            projectId: Id<"projects">,
            eventId: string;
          }>()

        toast.success("Importing repository...");
        onOpenChange(false);
        form.reset();

        router.push(`/projects/${projectId}`);
      } catch (error) {
        if (error instanceof HTTPError) {
          const body = await error.response.json<{ error: string; code?: string }>();
          if (body.code === GITHUB_NOT_LINKED) {
            setGithubNotLinked(true);
            return;
          }
        }
        toast.error("Unable to import repository. Please check the URL and try again");
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* A small window, like the prompt box: a mono bar, the form, a footer. */}
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden rounded-lg p-0 sm:max-w-lg">
        <div className="flex h-10 items-center justify-between border-b border-border bg-muted/40 pl-4 pr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" />
            New project
          </span>
          <DialogClose className="grid size-8 place-items-center rounded-md transition-colors hover:bg-muted hover:text-foreground">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <div className="px-6 pt-6 pb-6">
            <DialogHeader className="mb-6 text-left">
              <DialogTitle className="flex items-center gap-2.5 text-2xl font-semibold tracking-[-0.03em]">
                <FaGithub className="size-5" />
                <span>
                  Import from <span className="text-brand">GitHub</span>
                </span>
              </DialogTitle>
              <DialogDescription className="text-[15px] leading-relaxed">
                Paste a repository URL. A new project is created with its contents.
              </DialogDescription>
            </DialogHeader>
            <form.Field name="url">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel
                      htmlFor={field.name}
                      className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-muted-foreground"
                    >
                      Repository URL
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      placeholder="https://github.com/owner/repo"
                      className="h-10 rounded-md font-mono text-[13px] focus-visible:border-brand/50 focus-visible:ring-4 focus-visible:ring-brand/10"
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>
            {githubNotLinked && (
              <div className="mt-4">
                <GithubNotLinkedAlert description="This repository is private or doesn't exist. Public repositories import without GitHub; connect GitHub to import private ones." />
              </div>
            )}
          </div>
          <DialogFooter className="items-center border-t border-border bg-muted/30 px-6 py-3.5 sm:justify-between">
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:block">
              Public repos import without GitHub linked
            </span>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="rounded-md"
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting]}
              >
                {([canSubmit, isSubmitting]) => (
                  <Button
                    type="submit"
                    disabled={!canSubmit || isSubmitting}
                    className="sheen rounded-md bg-brand text-brand-foreground shadow-[inset_0_-4px_8px_rgb(0_0_0/0.12),0_1px_2px_rgb(232_130_79/0.4)] hover:bg-brand/90"
                  >
                    {isSubmitting ? "Importing..." : "Import"}
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
