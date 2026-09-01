"use client";

import React from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  EyeIcon,
  LinkIcon,
  PlugIcon,
  PlusIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  Unlink2Icon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
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

import { getProvider } from "../catalog";
import {
  useLinkConnectionToProject,
  useProjectConnections,
  useUnlinkProjectConnection,
  useUpdateProjectConnection,
  useUserConnections,
} from "../hooks/use-integrations";
import {
  ConnectionScopeForm,
  describeProviderScope,
  type ProviderScopeValue,
  type ScopeFormValue,
} from "./connection-scope-form";

import { Id } from "../../../../convex/_generated/dataModel";

/**
 * Links account-level connections to one project.
 *
 * ## Why this panel exists separately from the connections list
 *
 * A credential on its own gives an agent nothing: the agent resolves its MCP
 * servers from `projectConnections`, so an unlinked connection is invisible to
 * it. The account list answers "what credentials do I hold"; this panel answers
 * "what can the agent in *this* project reach, and how narrowly".
 *
 * ## What the copy is careful about
 *
 * - Linking always starts read-only. Allowing writes is a separate, confirmed
 *   action inside the scope editor.
 * - A scope change clears the server-side tool baseline, so a tool count is only
 *   shown while one exists. After an edit the row says tools will be
 *   re-discovered rather than repeating a number that no longer describes the
 *   current scope.
 */

/** Exactly what `listProjectConnections` returns, so the two cannot drift. */
type ProjectConnectionRow = NonNullable<
  ReturnType<typeof useProjectConnections>
>[number];

type AccountConnection = NonNullable<
  ReturnType<typeof useUserConnections>
>[number];

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

interface AccessPill {
  label: string;
  className: string;
}

/**
 * How this link's access reads at a glance.
 *
 * `supportsReadOnly: false` providers get their own wording: claiming
 * "Read-only" there would promise an enforcement that does not exist.
 */
const accessPill = (row: ProjectConnectionRow): AccessPill => {
  const provider = getProvider(row.connection.providerId);
  const enforced = provider?.supportsReadOnly ?? false;

  if (!row.readOnly) {
    return {
      label: "Writes allowed",
      className:
        "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    };
  }

  return enforced
    ? {
        label: "Read-only",
        className:
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
      }
    : {
        label: "Read-only not enforced",
        className:
          "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
      };
};

interface ProjectConnectionItemProps {
  row: ProjectConnectionRow;
}

const ProjectConnectionItem = ({ row }: ProjectConnectionItemProps) => {
  const updateConnection = useUpdateProjectConnection();
  const unlinkConnection = useUnlinkProjectConnection();

  const [editing, setEditing] = React.useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = React.useState(false);
  const [unlinking, setUnlinking] = React.useState(false);
  const [togglingEnabled, setTogglingEnabled] = React.useState(false);

  const editorId = React.useId();
  const enabledSwitchId = React.useId();

  const provider = getProvider(row.connection.providerId);
  const providerName = provider?.displayName ?? row.connection.providerId;
  const label = row.connection.label;
  const pill = accessPill(row);
  const scopeParts = describeProviderScope(provider, row.providerScope);

  const handleToggleEnabled = async (next: boolean) => {
    setTogglingEnabled(true);
    try {
      await updateConnection({ id: row._id, enabled: next });
      toast.success(
        next
          ? `${label} is available to this project's agent`
          : `${label} is paused for this project`
      );
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Unable to change this connection"));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleScopeSubmit = async (value: ScopeFormValue) => {
    try {
      await updateConnection({
        id: row._id,
        readOnly: value.readOnly,
        writeApproved: value.writeApproved,
        providerScope: value.providerScope,
      });
      toast.success(
        `Updated ${label} — tools are re-discovered on the next agent run`
      );
      setEditing(false);
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Unable to save this scope"));
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await unlinkConnection({ id: row._id });
      toast.success(`Unlinked ${label} from this project`);
      setConfirmUnlinkOpen(false);
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Unable to unlink this connection"));
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card">
      <div className="flex items-start gap-3 p-3">
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium text-foreground truncate">
              {label}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                pill.className
              )}
            >
              {row.readOnly ? (
                <EyeIcon aria-hidden="true" className="size-2.5" />
              ) : (
                <ShieldAlertIcon aria-hidden="true" className="size-2.5" />
              )}
              {pill.label}
            </span>
            {!row.enabled && (
              <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Paused
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{providerName}</span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span>
              {scopeParts.length > 0
                ? scopeParts.join(" · ")
                : "Provider default scope"}
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {row.toolCount !== undefined
              ? `${row.toolCount} ${
                  row.toolCount === 1 ? "tool" : "tools"
                } recorded for this scope${
                  row.toolBaselineAt !== undefined
                    ? ` ${formatDistanceToNow(row.toolBaselineAt, {
                        addSuffix: true,
                      })}`
                    : ""
                }.`
              : "Tools have not been recorded for this scope yet — the next agent run discovers them and asks you to approve anything destructive."}
          </p>

          {row.connection.status !== "active" && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              This credential is not active
              {row.connection.statusMessage
                ? `: ${row.connection.statusMessage}`
                : ""}
              . Its tools will fail until you reconnect it.
            </p>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1">
          <label htmlFor={enabledSwitchId} className="sr-only">
            {`Use ${label} in this project`}
          </label>
          <Switch
            id={enabledSwitchId}
            checked={row.enabled}
            disabled={togglingEnabled}
            onCheckedChange={(checked) => void handleToggleEnabled(checked)}
          />
          <button
            type="button"
            aria-label={`Edit scope for ${label}`}
            aria-expanded={editing}
            aria-controls={editorId}
            onClick={() => setEditing((open) => !open)}
            className="flex items-center justify-center size-7 rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Unlink ${label} from this project`}
            onClick={() => setConfirmUnlinkOpen(true)}
            className="flex items-center justify-center size-7 rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Unlink2Icon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </div>

      <div id={editorId}>
        {editing && (
          <div className="border-t border-border/60 p-3">
            <ConnectionScopeForm
              provider={provider}
              providerName={providerName}
              connectionLabel={label}
              initialReadOnly={row.readOnly}
              initialScope={row.providerScope as ProviderScopeValue}
              toolCount={row.toolCount}
              toolBaselineAt={row.toolBaselineAt}
              onSubmit={handleScopeSubmit}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}
      </div>

      <AlertDialog
        open={confirmUnlinkOpen}
        onOpenChange={setConfirmUnlinkOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {label} from this project?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent in this project loses these tools straight away, along
              with the scope you configured here. The credential itself stays in
              your account and any other project keeps its own link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlinking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlinking}
              onClick={(event) => {
                // Keep the dialog open while the mutation runs so the pending
                // state is visible rather than flashing closed.
                event.preventDefault();
                void handleUnlink();
              }}
            >
              {unlinking ? "Unlinking..." : "Unlink"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

interface AddConnectionListProps {
  projectId: Id<"projects">;
  available: readonly AccountConnection[];
}

const AddConnectionList = ({ projectId, available }: AddConnectionListProps) => {
  const linkConnection = useLinkConnectionToProject();
  const [linkingId, setLinkingId] =
    React.useState<Id<"userConnections"> | null>(null);

  if (available.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Every connection in your account is already linked to this project.
      </p>
    );
  }

  const handleLink = async (connection: AccountConnection) => {
    setLinkingId(connection._id);
    try {
      // No `readOnly` argument: the mutation defaults to read-only with writes
      // unapproved, and that default is the posture we want a new link to have.
      await linkConnection({ projectId, userConnectionId: connection._id });
      toast.success(
        `Linked ${connection.label} — read-only until you allow writes`
      );
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Unable to link this connection"));
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {available.map((connection) => {
        const provider = getProvider(connection.providerId);
        const providerName = provider?.displayName ?? connection.providerId;
        const pending = linkingId === connection._id;

        return (
          <button
            key={connection._id}
            type="button"
            disabled={pending}
            onClick={() => void handleLink(connection)}
            className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card p-2.5 text-left transition-colors hover:bg-muted/50 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {pending ? (
              <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <PlusIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground truncate">
                {connection.label}
              </span>
              <span className="block text-[11px] text-muted-foreground truncate">
                {providerName} · {connection.maskedPreview}
              </span>
            </span>
            <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
              {pending ? "Linking..." : "Add"}
            </span>
          </button>
        );
      })}
    </div>
  );
};

interface ProjectConnectionsPanelProps {
  projectId: Id<"projects">;
}

export const ProjectConnectionsPanel = ({
  projectId,
}: ProjectConnectionsPanelProps) => {
  const accountConnections = useUserConnections();
  const projectConnections = useProjectConnections(projectId);

  if (accountConnections === undefined || projectConnections === undefined) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
      >
        <Spinner className="size-3.5" />
        Loading this project&apos;s connections...
      </div>
    );
  }

  if (accountConnections.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center">
        <PlugIcon
          aria-hidden="true"
          className="size-4 text-muted-foreground/60"
        />
        <p className="text-xs font-medium text-foreground">
          Nothing to link yet
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Create a connection first — see{" "}
          <span className="font-medium text-foreground">Add a connection</span>{" "}
          below — then link it here to give this project&apos;s agent its tools.
        </p>
      </div>
    );
  }

  const linkedIds = new Set(
    projectConnections.map((row) => row.userConnectionId)
  );
  const available = accountConnections.filter(
    (connection) => !linkedIds.has(connection._id)
  );

  return (
    <div className="space-y-3">
      {projectConnections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center">
          <LinkIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground/60"
          />
          <p className="text-xs font-medium text-foreground">
            No connections linked to this project
          </p>
          <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground">
            Holding a credential is not enough on its own — the agent only sees
            connections that are linked to the project it is working in. Link one
            below to give it those tools. Links start read-only.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {projectConnections.map((row) => (
            <ProjectConnectionItem key={row._id} row={row} />
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">
          Add to this project
        </h4>
        <AddConnectionList projectId={projectId} available={available} />
      </div>
    </div>
  );
};
