import React from "react";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import { FaGithub } from "react-icons/fa";
import {
  CheckCheckIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { useSecurityGate } from "@/features/security/hooks/use-security-gate";
import { SecurityScanDialog } from "@/features/security/components/security-scan-dialog";

import { useProject, useUnpushedRuns } from "../hooks/use-projects";
import { GITHUB_NOT_LINKED, GITHUB_SYNC_BRANCH } from "../constants";
import { GithubNotLinkedAlert } from "./github-not-linked-alert";
import { DownloadZipButton } from "./download-zip-button";

import { Id } from "../../../../convex/_generated/dataModel";
import Link from "next/link";

const formSchema = z.object({
  repoName: z
    .string()
    .min(1, "Repository name is required")
    .max(100, "Repository name is too long")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Only alphanumeric characters, hyphens, underscores, and dots are allowed"
    ),
  visibility: z.enum(["public", "private"]),
  description: z.string().max(350, "Description is too long"),
});

interface ExportPopoverProps {
  projectId: Id<"projects">;
}

export const ExportPopover = ({ projectId }: ExportPopoverProps) => {
  const project = useProject(projectId);
  const [open, setOpen] = React.useState(false);
  const [githubNotLinked, setGithubNotLinked] = React.useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setGithubNotLinked(false);
    }
    setOpen(nextOpen);
  };

  const gate = useSecurityGate(projectId);
  const exportStatus = project?.exportStatus;
  const exportRepoUrl = project?.exportRepoUrl;
  const githubSync = project?.githubSync;
  const unpushed = useUnpushedRuns(projectId);

  const form = useForm({
    defaultValues: {
      repoName: project?.name?.replace(/[^a-zA-Z0-9._-]/g, "-") ?? "",
      visibility: "private" as "public" | "private",
      description: "",
    },
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: ({ value }) => gate.guard(() => startExport(value)),
  });

  const startJob = async (
    url: string,
    json: object,
    messages: { started: string; failed: string }
  ) => {
    setGithubNotLinked(false);
    try {
      await ky.post(url, { json });

      toast.success(messages.started);
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = await error.response.json<{ error: string; code?: string }>();
        if (body.code === GITHUB_NOT_LINKED) {
          setGithubNotLinked(true);
          return;
        }
      }
      toast.error(messages.failed);
    }
  };

  const startExport = (value: z.infer<typeof formSchema>) =>
    startJob(
      "/api/github/export",
      {
        projectId,
        repoName: value.repoName,
        visibility: value.visibility,
        description: value.description || undefined,
      },
      { started: "Export started...", failed: "Unable to export repository" }
    );

  const startPush = () =>
    startJob(
      "/api/github/push",
      { projectId },
      { started: "Push started...", failed: "Unable to push changes" }
    );

  const submitLabel = (isSubmitting: boolean) => {
    if (gate.checking) return "Checking for secrets...";
    return isSubmitting ? "Creating..." : "Create Repository";
  };

  const handleCancelExport = async () => {
    await ky.post("/api/github/export/cancel", {
      json: { projectId },
    });
  };

  const handleResetExport = async () => {
    await ky.post("/api/github/export/reset", {
      json: { projectId },
    });
    setOpen(false);
  };

  const renderContent = () => {
    if (exportStatus === "exporting") {
      return (
        <div className="flex flex-col items-center gap-3">
          <LoaderIcon className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {githubSync ? "Pushing to GitHub..." : "Exporting to GitHub..."}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={handleCancelExport}
          >
            Cancel
          </Button>
        </div>
      );
    }

    if (exportStatus === "completed" && exportRepoUrl && !githubSync) {
      return (
        <div className="flex flex-col items-center gap-3">
          <CheckCircle2Icon className="size-6 text-emerald-500" />
          <p className="text-sm font-medium">Repository created</p>
          <p className="text-xs text-muted-foreground text-center">
            Your project has been exported to GitHub.
          </p>
          <div className="flex flex-col w-full gap-2">
            <Button size="sm" className="w-full" asChild>
              <Link href={exportRepoUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon className="size-4 mr-1" />
                View on GitHub
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={handleResetExport}
            >
              Close
            </Button>
          </div>
        </div>
      )
    }

    if (exportStatus === "failed") {
      return (
        <div className="flex flex-col items-center gap-3">
          <XCircleIcon className="size-6 text-rose-500" />
          <p className="text-sm font-medium">
            {githubSync ? "Unable to push" : "Unable to export"}
          </p>
          <p className="text-xs text-muted-foreground text-center">
            {project?.exportError ?? "Something went wrong. Please try again."}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={handleResetExport}
          >
            Retry
          </Button>
        </div>
      );
    }

    if (githubSync) {
      const repoUrl = `https://github.com/${githubSync.repo}`;
      return (
        <div className="space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">Push to GitHub</h4>
            <p className="text-xs text-muted-foreground break-all">
              Linked to{" "}
              <span className="font-medium text-foreground">{githubSync.repo}</span>{" "}
              ({githubSync.branch})
            </p>
          </div>
          {githubSync.syncBranchSha && (
            <p className="text-xs text-muted-foreground">
              {githubSync.branch} changed on GitHub, so your changes are on the{" "}
              <span className="font-medium text-foreground">{GITHUB_SYNC_BRANCH}</span> branch.{" "}
              <Link
                href={`${repoUrl}/compare/${githubSync.branch}...${GITHUB_SYNC_BRANCH}?expand=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Open a pull request
              </Link>
            </p>
          )}
          {unpushed && (
            <p className="text-xs text-muted-foreground">
              {unpushed.running
                ? "An agent run is in progress. Push once it finishes."
                : unpushed.count === 0
                ? "No agent runs to push. Manual edits are pushed too."
                : `${unpushed.count}${unpushed.more ? "+" : ""} agent ${unpushed.count === 1 && !unpushed.more ? "run" : "runs"} not pushed yet.`}
            </p>
          )}
          {githubNotLinked && <GithubNotLinkedAlert />}
          <div className="flex flex-col w-full gap-2">
            <Button
              size="sm"
              className="w-full"
              disabled={gate.checking || !unpushed || unpushed.running}
              onClick={() => gate.guard(startPush)}
            >
              {gate.checking ? "Checking for secrets..." : "Push changes"}
            </Button>
            <Button size="sm" variant="outline" className="w-full" asChild>
              <Link href={repoUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon className="size-4 mr-1" />
                View on GitHub
              </Link>
            </Button>
          </div>
        </div>
      );
    }

    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">Export to GitHub</h4>
            <p className="text-xs text-muted-foreground">
              Export your project to a GitHub repository.
            </p>
          </div>
          <form.Field name="repoName">
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>
                    Repository Name
                  </FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="my-project"
                  />
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="visibility">
            {(field) => {
              return (
                <Field>
                  <FieldLabel htmlFor={field.name}>
                    Visibility
                  </FieldLabel>
                  <Select
                    value={field.state.value}
                    onValueChange={(value: "public" | "private") =>
                      field.handleChange(value)
                    }
                  >
                    <SelectTrigger id={field.name}>
                      <SelectValue placeholder="Select visibility" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="public">Public</SelectItem>
                    </SelectContent>
                  </Select>
            
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="description">
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>
                    Description
                  </FieldLabel>
                  <Textarea
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="A short description of your project"
                    rows={2}
                  />
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>

          {githubNotLinked && (
            <GithubNotLinkedAlert />
          )}

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
                {submitLabel(isSubmitting)}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    )
  };

  const getStatusIcon = () => {
    if (exportStatus === "exporting") {
      return <LoaderIcon className="size-3.5 animate-spin" />;
    }
    if (exportStatus === "completed") {
      return <CheckCheckIcon className="size-3.5 text-emerald-500" />;
    }
    if (exportStatus === "failed") {
      return <XCircleIcon className="size-3.5 text-red-500" />;
    }
    return <FaGithub className="size-3.5" />;
  };

  const hasUnpushed = !!unpushed && unpushed.count > 0;
  const triggerLabel = hasUnpushed ? "Export (unpushed changes)" : "Export";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          className="relative flex items-center gap-1.5 h-8 px-2 @3xl:px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors"
        >
          {getStatusIcon()}
          <span className="hidden @3xl:inline">Export</span>
          {hasUnpushed && (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        {renderContent()}
        <SecurityScanDialog pending={gate.pending} onDismiss={gate.dismiss} />
        <div className="mt-4 border-t pt-4">
          <DownloadZipButton projectId={projectId} />
        </div>
      </PopoverContent>
    </Popover>
  );
};
