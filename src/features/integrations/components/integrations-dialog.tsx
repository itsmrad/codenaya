"use client";

import { useState } from "react";
import { ArrowLeftIcon, PlugIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import { useUserConnections } from "../hooks/use-integrations";
import { getProvider } from "../catalog";
import { ConnectionCard } from "./connection-card";
import { ConnectApiKeyForm } from "./connect-api-key-form";
import { CUSTOM_PROVIDER_ID, ProviderCatalog } from "./provider-catalog";

interface IntegrationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const IntegrationsDialog = ({
  open,
  onOpenChange,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Connect external services so your agent can use their tools.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Your connections
            </h3>
            {renderConnections()}
          </section>

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
        </div>
      </DialogContent>
    </Dialog>
  );
};
