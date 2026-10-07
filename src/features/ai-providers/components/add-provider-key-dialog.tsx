"use client";

import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import { AlertCircleIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  MAX_CUSTOM_MODEL_IDS,
  type AiProviderId,
} from "../registry";
import {
  addAiProviderKey,
  aiProviderRequestError,
} from "../hooks/use-ai-providers";

/** Model ids entered one per line (commas also work). */
const parseModelIds = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

const formSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS),
    apiKey: z.string().trim().min(1, "An API key is required"),
    label: z.string().trim().max(80, "Label is too long"),
    baseUrl: z.string(),
    modelIds: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "custom") return;
    if (!z.string().url().safeParse(value.baseUrl.trim()).success) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Enter a full URL, for example https://api.example.com/v1",
      });
    }
    const modelIds = parseModelIds(value.modelIds);
    if (modelIds.length === 0 || modelIds.length > MAX_CUSTOM_MODEL_IDS) {
      ctx.addIssue({
        code: "custom",
        path: ["modelIds"],
        message: `Enter between 1 and ${MAX_CUSTOM_MODEL_IDS} model ids`,
      });
    }
  });

interface AddProviderKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AddProviderKeyDialog = ({
  open,
  onOpenChange,
}: AddProviderKeyDialogProps) => {
  // The route's own message (rejected key, unsafe URL, rate limit).
  const [requestError, setRequestError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: {
      provider: "openrouter" as AiProviderId,
      apiKey: "",
      label: "",
      baseUrl: "",
      modelIds: "",
    },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value }) => {
      setRequestError(null);
      const isCustom = value.provider === "custom";
      const label = value.label.trim() || AI_PROVIDERS[value.provider].label;
      try {
        await addAiProviderKey({
          provider: value.provider,
          apiKey: value.apiKey.trim(),
          label,
          baseUrl: isCustom ? value.baseUrl.trim() : undefined,
          modelIds: isCustom ? parseModelIds(value.modelIds) : undefined,
        });
        toast.success(`Added ${label}`);
        handleOpenChange(false);
      } catch (error) {
        setRequestError(await aiProviderRequestError(error));
      }
    },
  });

  // Closing drops the plaintext key from form state.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      form.reset();
      setRequestError(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add an API key</DialogTitle>
          <DialogDescription>
            We test the key with the provider before saving it, then store it
            encrypted.
          </DialogDescription>
        </DialogHeader>

        <form
          id="add-provider-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup className="gap-5">
            <form.Field name="provider">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Provider</FieldLabel>
                  <Select
                    value={field.state.value}
                    onValueChange={(value) =>
                      field.handleChange(value as AiProviderId)
                    }
                  >
                    <SelectTrigger id={field.name} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_PROVIDER_IDS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {AI_PROVIDERS[id].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.provider}>
              {(provider) =>
                provider === "custom" && (
                  <>
                    <form.Field name="baseUrl">
                      {(field) => {
                        const isInvalid = !field.state.meta.isValid;
                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              Base URL
                            </FieldLabel>
                            <Input
                              id={field.name}
                              name={field.name}
                              type="url"
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                              aria-invalid={isInvalid}
                              placeholder="https://api.example.com/v1"
                            />
                            <FieldDescription>
                              An OpenAI-compatible API root, the part before
                              /chat/completions.
                            </FieldDescription>
                            {isInvalid && (
                              <FieldError errors={field.state.meta.errors} />
                            )}
                          </Field>
                        );
                      }}
                    </form.Field>

                    <form.Field name="modelIds">
                      {(field) => {
                        const isInvalid = !field.state.meta.isValid;
                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>
                              Model ids
                            </FieldLabel>
                            <Textarea
                              id={field.name}
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                              aria-invalid={isInvalid}
                              placeholder={"llama-3.3-70b\nqwen-2.5-coder"}
                              rows={3}
                              className="font-mono text-sm"
                            />
                            <FieldDescription>
                              One per line, up to {MAX_CUSTOM_MODEL_IDS}. Pick
                              models that support tool calling.
                            </FieldDescription>
                            {isInvalid && (
                              <FieldError errors={field.state.meta.errors} />
                            )}
                          </Field>
                        );
                      }}
                    </form.Field>
                  </>
                )
              }
            </form.Subscribe>

            <form.Field name="apiKey">
              {(field) => {
                const isInvalid = !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>API key</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="password"
                      autoComplete="off"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      placeholder="Paste your API key"
                    />
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="label">
              {(field) => {
                const isInvalid = !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>
                      Label (optional)
                    </FieldLabel>
                    <form.Subscribe selector={(state) => state.values.provider}>
                      {(provider) => (
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                          aria-invalid={isInvalid}
                          placeholder={AI_PROVIDERS[provider].label}
                        />
                      )}
                    </form.Subscribe>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>

            {requestError && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon aria-hidden="true" />
                <AlertDescription>{requestError}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button
                type="submit"
                form="add-provider-key-form"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Testing key..." : "Add key"}
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
