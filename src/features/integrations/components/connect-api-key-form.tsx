"use client";

import React from "react";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import {
  CheckCircle2Icon,
  CircleSlashIcon,
  InfoIcon,
  LoaderIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

import { getProvider } from "../catalog";
import {
  useOAuthPopup,
  type OAuthPopupState,
} from "../hooks/use-oauth-popup";
import {
  CUSTOM_PROVIDER_ID,
  supportsApiKey,
  supportsOAuth,
} from "./provider-catalog";

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

interface OAuthConnectPanelProps {
  providerId: string;
  displayName: string;
  /**
   * True when the same provider also accepts an API key, so OAuth is one of two
   * choices and worth marking as the better one.
   */
  isRecommended: boolean;
  onConnected?: () => void;
}

/**
 * OAuth half of the connect flow.
 *
 * Split into its own component so `useOAuthPopup` is only mounted for providers
 * that can actually use it — the parent early-returns for other shapes, and
 * hooks cannot sit behind a return.
 */
const OAuthConnectPanel = ({
  providerId,
  displayName,
  isRecommended,
  onConnected,
}: OAuthConnectPanelProps) => {
  const { state, error, start } = useOAuthPopup();

  // Remembers which outcome has already been announced, so a re-render (or a
  // development double-invoked effect) cannot fire the same toast twice.
  const notifiedRef = React.useRef<OAuthPopupState | null>(null);

  React.useEffect(() => {
    if (state !== "success" && state !== "error") return;
    if (notifiedRef.current === state) return;
    notifiedRef.current = state;

    if (state === "success") {
      // The connections list is a live Convex query and updates on its own.
      toast.success(`Connected ${displayName}`);
      onConnected?.();
      return;
    }

    toast.error(error ?? FALLBACK_MESSAGE);
  }, [state, error, displayName, onConnected]);

  const handleStart = () => {
    notifiedRef.current = null;
    void start(providerId);
  };

  const isPending = state === "pending";
  const needsRetry = state === "error" || state === "cancelled";

  const buttonLabel = isPending
    ? `Waiting for ${displayName}...`
    : needsRetry
      ? "Try again"
      : `Connect with ${displayName}`;

  const renderStatus = () => {
    if (isPending) {
      return (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <LoaderIcon
            aria-hidden="true"
            className="size-3 shrink-0 mt-0.5 animate-spin"
          />
          Finish signing in to {displayName} in the window we opened. It closes
          itself once you are done.
        </p>
      );
    }

    if (state === "success") {
      return (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon
            aria-hidden="true"
            className="size-3 shrink-0 mt-0.5"
          />
          Connected. {displayName} now appears under your connections above.
        </p>
      );
    }

    if (state === "cancelled") {
      return (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <CircleSlashIcon
            aria-hidden="true"
            className="size-3 shrink-0 mt-0.5"
          />
          The sign-in window closed before {displayName} finished authorising.
          Nothing was connected.
        </p>
      );
    }

    if (state === "error") {
      return (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">
          <XCircleIcon aria-hidden="true" className="size-3 shrink-0 mt-0.5" />
          {error ?? FALLBACK_MESSAGE}
        </p>
      );
    }

    return null;
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3">
        <ShieldCheckIcon
          aria-hidden="true"
          className="size-4 shrink-0 mt-0.5 text-muted-foreground"
        />
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-foreground">
              Authorise with {displayName}
            </p>
            {isRecommended && (
              <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Recommended
              </span>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {displayName} opens in a small window to confirm what Codenaya may
            do. There is no key to paste, and you can revoke access from{" "}
            {displayName} at any time.
          </p>
        </div>
      </div>

      <Button
        type="button"
        size="sm"
        className="w-full"
        onClick={handleStart}
        disabled={isPending}
      >
        {isPending ? (
          <LoaderIcon aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <ShieldCheckIcon aria-hidden="true" className="size-3.5" />
        )}
        {buttonLabel}
      </Button>

      {/* Declared unconditionally so the outcome is announced when it arrives. */}
      <div role="status" aria-live="polite">
        {renderStatus()}
      </div>
    </div>
  );
};

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

  const oauthAvailable = provider ? supportsOAuth(provider.authModes) : false;
  // Custom servers are always key-based; catalog providers say so themselves.
  const apiKeyAvailable = isCustom
    ? true
    : provider
      ? supportsApiKey(provider.authModes)
      : true;

  // OAuth is the default path when a provider offers both: it is revocable at
  // the provider and avoids storing a long-lived key. The key form stays one
  // click away rather than being removed.
  const [showApiKey, setShowApiKey] = React.useState(!oauthAvailable);
  const apiKeyPanelId = React.useId();

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

  const description = isCustom
    ? "Point Codenaya at any public https MCP endpoint. We verify it before saving."
    : oauthAvailable && apiKeyAvailable
      ? "Authorise through the provider, or paste an API key. OAuth is recommended — it is revocable and stores no long-lived key."
      : oauthAvailable
        ? "This provider authorises through OAuth, so there is no key to paste."
        : "We verify the key against the provider before saving it.";

  const notes = provider?.notes ? (
    <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
      <InfoIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 mt-0.5 text-muted-foreground"
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {provider.notes}
      </p>
    </div>
  ) : null;

  const apiKeyForm = (
    <form
      id={apiKeyPanelId}
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <div className="space-y-4">
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

        {notes}

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

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Connect {displayName}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {oauthAvailable && (
        <OAuthConnectPanel
          providerId={providerId}
          displayName={displayName}
          isRecommended={apiKeyAvailable}
          onConnected={onConnected}
        />
      )}

      {oauthAvailable && apiKeyAvailable && (
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
          <button
            type="button"
            aria-expanded={showApiKey}
            aria-controls={apiKeyPanelId}
            onClick={() => setShowApiKey((shown) => !shown)}
            className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showApiKey ? "Hide the API key option" : "Use an API key instead"}
          </button>
          <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
        </div>
      )}

      {apiKeyAvailable && (!oauthAvailable || showApiKey) && apiKeyForm}

      {/* Notes normally live inside the key form; surface them when it is hidden. */}
      {!(apiKeyAvailable && (!oauthAvailable || showApiKey)) && notes}
    </div>
  );
};
