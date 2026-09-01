"use client";

import React from "react";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import { CheckCircle2Icon, InfoIcon, LockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

import { getProvider } from "../catalog";
import { CUSTOM_PROVIDER_ID, supportsApiKey } from "./provider-catalog";

/**
 * Failure `kind`s from `/api/integrations/connect`, translated into something a
 * user can act on. The raw error text names internals (SSRF verdicts, JSON-RPC
 * framing), so it is logged-only from the user's point of view.
 */
const KIND_MESSAGES: Record<string, string> = {
  unauthorized:
    "The provider rejected that credential. Check the key is correct, still active, and has the permissions you expect.",
  network:
    "We could not reach that server. Check the URL is right and publicly reachable.",
  blocked:
    "That URL was rejected for security reasons. MCP servers must be public https endpoints.",
  protocol:
    "That address responded, but it does not speak MCP. Check you used the server's MCP endpoint.",
  timeout: "The server did not respond in time. Try again, or check it is online.",
};

const FALLBACK_MESSAGE = "Unable to connect. Please try again.";

interface ConnectSuccess {
  connectionId: string;
  provider: { id: string; displayName: string };
  toolCount: number;
  truncated: boolean;
  tools: { name: string; description?: string }[];
  serverName?: string;
}

/** Number of discovered tools listed back to the user on success. */
const TOOL_PREVIEW_COUNT = 6;

const buildSchema = (isCustom: boolean) =>
  z.object({
    apiKey: z.string().min(1, "An API key is required"),
    label: z.string().max(80, "Label is too long"),
    serverUrl: isCustom
      ? z
          .string()
          .min(1, "A server URL is required for a custom MCP server")
          .url("Enter a full URL, for example https://mcp.example.com/mcp")
          .refine(
            (value) => value.toLowerCase().startsWith("https://"),
            "The URL must use https://"
          )
      : z.string(),
  });

interface ConnectApiKeyFormProps {
  providerId: string;
  /** Called after a connection is created, so the parent can reset its flow. */
  onConnected?: () => void;
}

export const ConnectApiKeyForm = ({
  providerId,
  onConnected,
}: ConnectApiKeyFormProps) => {
  const isCustom = providerId === CUSTOM_PROVIDER_ID;
  const provider = isCustom ? undefined : getProvider(providerId);

  const displayName = isCustom
    ? "Custom MCP server"
    : provider?.displayName ?? providerId;

  const [success, setSuccess] = React.useState<ConnectSuccess | null>(null);

  const form = useForm({
    defaultValues: {
      apiKey: "",
      label: "",
      serverUrl: "",
    },
    validators: {
      onSubmit: buildSchema(isCustom),
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await ky
          .post("/api/integrations/connect", {
            json: {
              providerId,
              apiKey: value.apiKey,
              label: value.label.trim() || undefined,
              serverUrl: isCustom ? value.serverUrl.trim() : undefined,
            },
          })
          .json<ConnectSuccess & { ok: true }>();

        setSuccess(result);
        toast.success(`Connected ${result.provider.displayName}`);
        onConnected?.();
      } catch (error) {
        if (error instanceof HTTPError) {
          const body = await error.response
            .json<{ error?: string; kind?: string }>()
            .catch(() => ({ error: undefined, kind: undefined }));

          const mapped = body.kind ? KIND_MESSAGES[body.kind] : undefined;
          toast.error(mapped ?? body.error ?? FALLBACK_MESSAGE);
          return;
        }

        toast.error(FALLBACK_MESSAGE);
      }
    },
  });

  // ── OAuth-only providers never get a key field ──
  //
  // The route rejects the attempt anyway, but offering an input the user cannot
  // succeed with is worse than saying plainly that it is not ready.
  if (provider && !supportsApiKey(provider.authModes)) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <LockIcon
            aria-hidden="true"
            className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"
          />
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              {displayName} requires OAuth
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              This provider does not accept API keys — it only authorises
              through OAuth, which is coming in a later step. Pick a different
              provider for now, or add it as a custom MCP server if you have an
              endpoint that accepts a token.
            </p>
          </div>
        </div>
        {provider.notes && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {provider.notes}
          </p>
        )}
      </div>
    );
  }

  if (success) {
    const preview = success.tools.slice(0, TOOL_PREVIEW_COUNT);
    const remaining = success.toolCount - preview.length;

    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <CheckCircle2Icon
            aria-hidden="true"
            className="size-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400"
          />
          <div className="space-y-1.5 min-w-0">
            <p className="text-xs font-medium text-foreground">
              {success.serverName ?? success.provider.displayName} connected —{" "}
              {success.toolCount} {success.toolCount === 1 ? "tool" : "tools"}{" "}
              available
            </p>
            {preview.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {preview.map((tool) => (
                  <span
                    key={tool.name}
                    className="inline-flex items-center rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {tool.name}
                  </span>
                ))}
                {remaining > 0 && (
                  <span className="inline-flex items-center px-1 py-0.5 text-[10px] text-muted-foreground/70">
                    +{remaining} more
                  </span>
                )}
              </div>
            )}
            {success.truncated && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                This server advertises more tools than we record; the list above
                is a sample.
              </p>
            )}
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            setSuccess(null);
            form.reset();
          }}
        >
          Add another connection
        </Button>
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
          <h4 className="text-sm font-medium">Connect {displayName}</h4>
          <p className="text-xs text-muted-foreground">
            {isCustom
              ? "Point Codenaya at any public https MCP endpoint. We verify it before saving."
              : "We verify the key against the provider before saving it."}
          </p>
        </div>

        {isCustom && (
          <form.Field name="serverUrl">
            {(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Server URL</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="url"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="https://mcp.example.com/mcp"
                  />
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>
        )}

        <form.Field name="apiKey">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;

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
                  placeholder={provider?.apiKey?.hint ?? "Paste your API key"}
                />
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>

        <form.Field name="label">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid;

            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Label (optional)</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-invalid={isInvalid}
                  placeholder={displayName}
                />
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            );
          }}
        </form.Field>

        {provider?.notes && (
          <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
            <InfoIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 mt-0.5 text-muted-foreground"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {provider.notes}
            </p>
          </div>
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
              {isSubmitting ? "Verifying..." : "Connect"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
};
