"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Trash2Icon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

import { AI_PROVIDERS } from "../registry";
import {
  aiProviderRequestError,
  testAiProviderKey,
  useRemoveAiProviderKey,
} from "../hooks/use-ai-providers";
import type { AiProviderKeySummary } from "../../../../convex/aiProviders";

/** Each status carries its own text so it never relies on colour alone. */
const STATUS_BADGES: Record<
  AiProviderKeySummary["status"],
  { label: string; className: string }
> = {
  active: {
    label: "Active",
    className:
      "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  invalid: {
    label: "Invalid",
    className:
      "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
};

interface ProviderKeyCardProps {
  providerKey: AiProviderKeySummary;
}

export const ProviderKeyCard = ({ providerKey }: ProviderKeyCardProps) => {
  const removeKey = useRemoveAiProviderKey();

  const [testing, setTesting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { label, provider, maskedPreview, status, lastTestedAt } = providerKey;
  const badge = STATUS_BADGES[status];
  const providerLabel = AI_PROVIDERS[provider].label;

  const handleTest = async () => {
    setTesting(true);
    try {
      // The new status and test time arrive through the live `list` query.
      await testAiProviderKey(providerKey._id);
      toast.success(`${label} is working`);
    } catch (error) {
      toast.error(await aiProviderRequestError(error));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await removeKey({ keyId: providerKey._id });
      toast.success(`Removed ${label}`);
      setConfirmOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Unable to remove this key",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Item role="listitem" aria-label={label} variant="outline" size="sm">
      {/* Wide enough that the actions wrap below the details on phones. */}
      <ItemContent className="min-w-56">
        <ItemTitle className="w-full min-w-0">
          <span className="truncate">{label}</span>
          <Badge className={badge.className}>{badge.label}</Badge>
        </ItemTitle>
        <ItemDescription className="flex flex-wrap gap-x-2 gap-y-0.5">
          <span>{providerLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{maskedPreview}</span>
          {lastTestedAt !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Tested {formatDistanceToNow(lastTestedAt, { addSuffix: true })}
              </span>
            </>
          )}
        </ItemDescription>
        {providerKey.baseUrl && (
          <ItemDescription className="truncate font-mono text-xs">
            {providerKey.baseUrl}
          </ItemDescription>
        )}
        {/* A key is only marked invalid when the provider rejected it. */}
        {status === "invalid" && (
          <p className="text-xs text-destructive">
            {providerLabel} rejected this key. Runs that use it fail until you
            replace it.
          </p>
        )}
      </ItemContent>

      <ItemActions>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleTest()}
          disabled={testing}
        >
          {testing && <Spinner />}
          {testing ? "Testing..." : "Test"}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${label}`}
          onClick={() => setConfirmOpen(true)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </ItemActions>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored key is deleted and cannot be recovered. If it is your
              default, new runs go back to Codenaya&apos;s models.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                // Stay open while the mutation runs so the pending state shows.
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Item>
  );
};
