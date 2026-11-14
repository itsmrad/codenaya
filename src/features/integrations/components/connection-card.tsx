"use client";

import React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { convexErrorMessage } from "@/lib/convex-error";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ConnectApiKeyForm } from "./connect-api-key-form";
import { getProvider } from "../catalog";
import { useConnectionProjects, useDeleteUserConnection } from "../hooks/use-integrations";
import { Id } from "../../../../convex/_generated/dataModel";

/**
 * The shape `useUserConnections()` yields. Declared structurally here rather
 * than imported so this card stays usable for any equivalent summary.
 */
export interface ConnectionSummary {
  _id: Id<"userConnections">;
  providerId: string;
  label: string;
  authMode: "oauth" | "api_key";
  serverUrl: string;
  status: "active" | "needs_reauth" | "revoked" | "error";
  statusMessage?: string;
  maskedPreview: string;
  scopes: string[];
  tokenExpiresAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Status presentation. Every entry carries its own text so the pill never
 * relies on colour alone to convey state.
 */
const STATUS_STYLES: Record<
  ConnectionSummary["status"],
  { label: string; className: string }
> = {
  active: {
    label: "Active",
    className:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  needs_reauth: {
    label: "Needs reauth",
    className:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  revoked: {
    label: "Revoked",
    className:
      "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
  error: {
    label: "Error",
    className:
      "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
};

interface ConnectionCardProps {
  connection: ConnectionSummary;
}

export const ConnectionCard = ({ connection }: ConnectionCardProps) => {
  const deleteConnection = useDeleteUserConnection();
  const projects = useConnectionProjects(connection._id);
  const [reconnectOpen, setReconnectOpen] = React.useState(false);

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const provider = getProvider(connection.providerId);
  const providerName = provider?.displayName ?? connection.providerId;
  const status = STATUS_STYLES[connection.status];

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { unlinkedProjects } = await deleteConnection({
        id: connection._id,
      });

      toast.success(
        unlinkedProjects === 0
          ? `Removed ${connection.label}`
          : `Removed ${connection.label} — unlinked from ${unlinkedProjects} ${
              unlinkedProjects === 1 ? "project" : "projects"
            }`
      );
      setConfirmOpen(false);
    } catch (error: unknown) {
      toast.error(convexErrorMessage(error, "Unable to remove this connection"));
    } finally {
      setDeleting(false);
    }
  };

  const statusPill = (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        status.className
      )}
    >
      {status.label}
    </span>
  );

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-border/60 bg-card">
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground truncate">
            {connection.label}
          </span>
          {connection.statusMessage ? (
            <Tooltip>
              <TooltipTrigger asChild>{statusPill}</TooltipTrigger>
              <TooltipContent>{connection.statusMessage}</TooltipContent>
            </Tooltip>
          ) : (
            statusPill
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{providerName}</span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span className="font-mono">{connection.maskedPreview}</span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            {connection.authMode === "oauth" ? "OAuth" : "API key"}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            Added{" "}
            {formatDistanceToNow(connection.createdAt, { addSuffix: true })}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {connection.lastUsedAt === undefined ? "Not used yet" : `Last used ${formatDistanceToNow(connection.lastUsedAt, { addSuffix: true })}`}
        </p>
        <div className="text-[11px] text-muted-foreground space-y-1">
          <p>Projects{projects?.length === 0 ? ": None. Link from a project's Integrations dialog." : ":"}</p>
          {projects?.map((project) => (
            <p key={project.projectId} className="break-words">
              <Link className="underline" href={`/projects/${project.projectId}`}>{project.name}</Link>
              {" — "}{project.readOnly ? "Read-only" : "Read-write"}{!project.enabled && " (disabled)"}
              {Object.entries(project.providerScope).map(([key, value]) => ` · ${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("")}
              {project.allowedTools && ` · Tools: ${project.allowedTools.join(", ")}`}
            </p>
          ))}
        </div>
        {connection.status !== "active" && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Reconnect ${connection.label} connection`}
            onClick={() => setReconnectOpen(true)}
          >
            Reconnect
          </Button>
        )}
      </div>

      <Dialog open={reconnectOpen} onOpenChange={setReconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconnect {connection.label}</DialogTitle>
            <DialogDescription>Your project links and scopes will be kept.</DialogDescription>
          </DialogHeader>
          <ConnectApiKeyForm providerId={connection.providerId} connection={connection} onConnected={() => setReconnectOpen(false)} />
        </DialogContent>
      </Dialog>

      <button
        type="button"
        aria-label={`Remove ${connection.label} connection`}
        onClick={() => setConfirmOpen(true)}
        className="shrink-0 flex items-center justify-center size-7 rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trash2Icon aria-hidden="true" className="size-3.5" />
      </button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {connection.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the stored credential and unlinks the connection from
              every project that uses it. Agents in those projects will lose
              these tools immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                // Keep the dialog mounted while the mutation is in flight so the
                // pending state is visible instead of flashing closed.
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
