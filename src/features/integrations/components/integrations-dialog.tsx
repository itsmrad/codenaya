"use client";

import { useState } from "react";
import { ArrowLeftIcon, ChevronDownIcon, PlugIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";

import { useUserConnections } from "../hooks/use-integrations";
import { getProvider } from "../catalog";
import { ConnectionCard } from "./connection-card";
import { ConnectApiKeyForm } from "./connect-api-key-form";
import { ProjectConnectionsPanel } from "./project-connections-panel";
import { CUSTOM_PROVIDER_ID, ProviderCatalog } from "./provider-catalog";

import { Id } from "../../../../convex/_generated/dataModel";

interface IntegrationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When supplied, the dialog leads with this project's linked connections and
   * demotes the account-level list to a collapsible section. Omitting it keeps
   * the account-only dialog exactly as it was.
   */
  projectId?: Id<"projects">;
}

export const IntegrationsDialog = ({
  open,
  onOpenChange,
  projectId,
}: IntegrationsDialogProps) => {
  const connections = useUserConnections();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null
  );

  // Reopening should start at the catalog rather than resuming a half-filled
  // form for a provider the user has since forgotten about.
  //
  // Adjusted during render rather than in an effect: an effect would render the
  // stale provider once before clearing it, and React documents this as the way
  // to reset state when a prop changes.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && selectedProviderId !== null) {
      setSelectedProviderId(null);
    }
  }

  // In project mode the account-level sections are secondary, so they start
  // collapsed — unless there is nothing to link yet, in which case creating a
  // connection is the only useful next step and the section opens itself.
  //
  // Derived rather than stored, so it can react to the query resolving without
  // a setState in an effect.
  const [accountSectionOverride, setAccountSectionOverride] = useState<
    boolean | null
  >(null);
  const accountSectionOpen =
    accountSectionOverride ??
    (connections !== undefined && connections.length === 0);

  const selectedName =
    selectedProviderId === CUSTOM_PROVIDER_ID
      ? "Custom MCP server"
      : selectedProviderId
        ? getProvider(selectedProviderId)?.displayName ?? selectedProviderId
        : null;

  const renderConnections = () => {
    if (connections === undefined) {
      return (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading connections...
        </div>
      );
    }

    if (connections.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center">
          <PlugIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground/60"
          />
          <p className="text-xs font-medium text-foreground">
            No connections yet
          </p>
          <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
            A connection gives your agent real tools — query your database,
            open a pull request, look up live docs — using your own credentials.
            Connections belong to you and can be linked to any of your projects.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {connections.map((connection) => (
          <ConnectionCard key={connection._id} connection={connection} />
        ))}
      </div>
    );
  };

  const accountConnectionsSection = (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        Your connections
      </h3>
      {renderConnections()}
    </section>
  );

  const addConnectionSection = (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        {selectedProviderId && (
          <button
            type="button"
            aria-label="Back to provider list"
            onClick={() => setSelectedProviderId(null)}
            className="flex items-center justify-center size-6 rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          </button>
        )}
        <h3 className="text-xs font-medium text-muted-foreground">
          {selectedName ? `Add ${selectedName}` : "Add a connection"}
        </h3>
      </div>

      {selectedProviderId ? (
        <ConnectApiKeyForm providerId={selectedProviderId} />
      ) : (
        <ProviderCatalog onSelect={setSelectedProviderId} />
      )}
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[85vh] overflow-y-auto",
          projectId ? "sm:max-w-xl" : "sm:max-w-lg"
        )}
      >
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            {projectId
              ? "Link your connections to this project so its agent can use their tools."
              : "Connect external services so your agent can use their tools."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {projectId ? (
            <>
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  This project&apos;s connections
                </h3>
                <ProjectConnectionsPanel projectId={projectId} />
              </section>

              <Collapsible
                open={accountSectionOpen}
                onOpenChange={setAccountSectionOverride}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDownIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 transition-transform",
                        accountSectionOpen && "rotate-180"
                      )}
                    />
                    Your account connections
                    <span className="font-normal text-muted-foreground/70">
                      {accountSectionOpen
                        ? "— hide"
                        : "— add or remove credentials"}
                    </span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-5 pt-3">
                  {accountConnectionsSection}
                  {addConnectionSection}
                </CollapsibleContent>
              </Collapsible>
            </>
          ) : (
            <>
              {accountConnectionsSection}
              {addConnectionSection}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
