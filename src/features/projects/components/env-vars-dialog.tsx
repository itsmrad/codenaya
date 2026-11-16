"use client";

import ky, { HTTPError } from "ky";
import { z } from "zod";
import { Fragment, useId, useState } from "react";
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import {
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import {
  classifyEnvKey,
  isValidEnvKey,
} from "@/features/integrations/env-keys";
import { publicNameLooksSecret, publicValueSecretRule } from "@/features/integrations/credential-guard";
import {
  useDeleteEnvVar,
  useEnvVars,
  useSetPublicEnvVar,
} from "@/features/integrations/hooks/use-integrations";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

import { Id } from "../../../../convex/_generated/dataModel";

import { useProject } from "../hooks/use-projects";
import { missingEnvVarsMessage } from "../utils/import-notice";

const MASK = "••••••••";
const PUBLIC_NAME_WARNING = "This name looks like a secret, but its public prefix means it will be visible in the browser. Use a name without the prefix and store it as a secret.";

const formSchema = z.object({
  key: z
    .string()
    .trim()
    .refine(isValidEnvKey, "Use letters, digits and underscores only"),
  value: z.string().min(1, "Value is required"),
});

/**
 * Settings dialog for a project's environment variables.
 *
 * Public variables (NEXT_PUBLIC_*, VITE_*, …) go straight to Convex. Secrets are
 * sealed server-side by `/api/env-vars`, mirroring the agent's `setEnvVar` tool,
 * and are never sent back to the browser — only their masked preview is shown.
 */
interface EnvVarsDialogProps {
  projectId: Id<"projects">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const EnvVarsDialog = ({ projectId, open, onOpenChange }: EnvVarsDialogProps) => {
  const warningIdBase = useId();
  const keyWarningId = `${warningIdBase}-key-warning`;
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const project = useProject(projectId);
  const envVars = useEnvVars(open ? projectId : undefined);
  const missingNames = (project?.importInfo?.envVarNames ?? []).filter(
    (name) => !envVars?.some((envVar) => envVar.key === name),
  );
  const setPublicEnvVar = useSetPublicEnvVar();
  const deleteEnvVar = useDeleteEnvVar();

  const form = useForm({
    defaultValues: { key: "", value: "" },
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      const key = value.key.trim();
      try {
        if (classifyEnvKey(key) === "public") {
          if (publicValueSecretRule(value.value)) {
            toast.error(`This looks like a secret key. ${key} would be published in the browser bundle; use a name without a public prefix.`);
            return;
          }
          await setPublicEnvVar({ projectId, key, value: value.value });
        } else {
          await ky.post("/api/env-vars", {
            json: { projectId, key, value: value.value },
          });
        }
        toast.success(`Saved ${key}`);
        form.reset();
      } catch (error) {
        let message = `Unable to save ${key}`;
        if (error instanceof HTTPError) {
          const body = await error.response
            .json<{ error?: string }>()
            .catch(() => undefined);
          if (body?.error) message = body.error;
        }
        toast.error(message);
      }
    },
  });

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDelete = async (id: Id<"projectEnvVars">, key: string) => {
    try {
      await deleteEnvVar({ id });
      toast.success(`Deleted ${key}`);
    } catch {
      toast.error(`Unable to delete ${key}`);
    }
  };

  // Opened from the preview toolbar or the command palette, so reset on close.
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      form.reset();
      setRevealed(new Set());
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Environment Variables</DialogTitle>
          <DialogDescription>
            Keys starting with NEXT_PUBLIC_, VITE_ or PUBLIC_ are public. Anything
            else is encrypted and only available in the Cloud Sandbox. Restart the
            preview to apply changes.
          </DialogDescription>
        </DialogHeader>

        {envVars !== undefined && missingNames.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {missingEnvVarsMessage(missingNames.length)}{" "}
              Select a name and enter its value to save it.
            </p>
            <div className="relative">
              <div
                tabIndex={0}
                role="region"
                aria-label="Detected environment variable names"
                className="max-h-56 overflow-y-auto divide-y rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {missingNames.map((name) => (
                  <div key={name} className="flex flex-wrap items-center gap-2 p-2 text-xs">
                    {/* <wbr> after each "_" so long names wrap at underscores, not mid-word. */}
                    <span className="min-w-0 flex-1 break-words font-mono">
                      {name.split("_").map((part, i) => (
                        <Fragment key={i}>
                          {i > 0 && (
                            <>
                              _<wbr />
                            </>
                          )}
                          {part}
                        </Fragment>
                      ))}
                    </span>
                    <Badge variant="outline">{classifyEnvKey(name) === "public" ? "Public" : "Secret"}</Badge>
                    <Button size="sm" variant="ghost" aria-label={`Set ${name}`} aria-describedby={publicNameLooksSecret(name) ? `${warningIdBase}-detected-${name}` : undefined} onClick={() => {
                      form.setFieldValue("key", name);
                      form.setFieldValue("value", "");
                      document.getElementById("env-var-value")?.focus();
                    }}>Set value</Button>
                    {publicNameLooksSecret(name) && (
                      <p id={`${warningIdBase}-detected-${name}`} role="note" className="w-full text-amber-700 dark:text-amber-400">
                        {PUBLIC_NAME_WARNING}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {/* shortcut: fade stays visible at the end of the scroll, drop it once a scroll-end hook exists. */}
              {missingNames.length > 4 && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-md bg-gradient-to-t from-background to-transparent"
                />
              )}
            </div>
          </div>
        )}

        <div className="max-h-64 overflow-y-auto rounded-md border border-border/50 divide-y divide-border/50">
          {envVars === undefined && (
            <p className="p-3 text-xs text-muted-foreground">Loading...</p>
          )}
          {envVars?.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">
              No environment variables yet.
            </p>
          )}
          {envVars?.map((envVar) => {
            const isPublic = envVar.visibility === "public";
            const isRevealed = revealed.has(envVar.key);

            return (
              <div
                key={envVar._id}
                className="flex items-center gap-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-xs font-medium">
                      {envVar.key}
                    </span>
                    <Badge variant={isPublic ? "outline" : "secondary"}>
                      {isPublic ? "Public" : "Secret"}
                    </Badge>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {isPublic
                      ? isRevealed
                        ? envVar.value
                        : MASK
                      : envVar.maskedPreview}
                  </p>
                </div>
                {isPublic ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title={isRevealed ? "Hide value" : "Reveal value"}
                    aria-label={`${isRevealed ? "Hide" : "Reveal"} ${envVar.key}`}
                    onClick={() => toggleReveal(envVar.key)}
                  >
                    {isRevealed ? (
                      <EyeOffIcon className="size-3.5" />
                    ) : (
                      <EyeIcon className="size-3.5" />
                    )}
                  </Button>
                ) : (
                  <span
                    className="flex size-7 items-center justify-center text-muted-foreground"
                    title="Encrypted. Secret values cannot be revealed."
                  >
                    <LockIcon className="size-3.5" />
                  </span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Edit"
                  aria-label={`Edit ${envVar.key}`}
                  onClick={() => {
                    form.setFieldValue("key", envVar.key);
                    form.setFieldValue("value", envVar.value ?? "");
                  }}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 hover:text-destructive"
                  title="Delete"
                  aria-label={`Delete ${envVar.key}`}
                  onClick={() => handleDelete(envVar._id, envVar.key)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <form.Field name="key">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                const key = field.state.value.trim();

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor="env-var-key">Key</FieldLabel>
                    <Input
                      id="env-var-key"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      aria-describedby={publicNameLooksSecret(key) ? keyWarningId : undefined}
                      placeholder="NEXT_PUBLIC_API_URL"
                      className="font-mono"
                      autoComplete="off"
                    />
                    {publicNameLooksSecret(key) && (
                      <p id={keyWarningId} role="note" className="text-xs text-amber-700 dark:text-amber-400">
                        {PUBLIC_NAME_WARNING}
                      </p>
                    )}
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : (
                      key && (
                        <FieldDescription>
                          Stored as{" "}
                          {classifyEnvKey(key) === "public"
                            ? "public"
                            : "encrypted secret"}
                        </FieldDescription>
                      )
                    )}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="value">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor="env-var-value">Value</FieldLabel>
                    <Input
                      id="env-var-value"
                      name={field.name}
                      type="password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      className="font-mono"
                      autoComplete="off"
                    />
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>
          </div>
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
                {isSubmitting ? "Saving..." : "Save Variable"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
};
