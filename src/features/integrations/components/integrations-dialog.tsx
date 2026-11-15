"use client";

import { useState } from "react";
import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import type { CustomServerPrefill } from "../community-catalog";
import { ConnectionCard } from "./connection-card";
import { ConnectApiKeyForm } from "./connect-api-key-form";
import { ProjectConnectionsPanel } from "./project-connections-panel";
import { CUSTOM_PROVIDER_ID, ProviderCatalog } from "./provider-catalog";

import { Id } from "../../../../convex/_generated/dataModel";

interface IntegrationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: Id<"projects">;
  initialProviderId?: string;
  /** Opens the custom-server form prefilled for a community server. */
  initialPrefill?: CustomServerPrefill;
}

export const IntegrationsDialog = ({
  open,
  onOpenChange,
  projectId,
  initialProviderId,
  initialPrefill,
}: IntegrationsDialogProps) => {
  const connections = useUserConnections();
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProviderId ?? null);
  const [prefill, setPrefill] = useState(initialPrefill);
  // Prefilled community servers always start a new custom connection.
  const [addingConnection, setAddingConnection] = useState<boolean | null>(initialPrefill ? true : null);
  const [accountSectionOpen, setAccountSectionOpen] = useState(!!projectId);

  // Each opening starts at the requested provider, without resuming an old form.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setSelectedProviderId(open ? initialProviderId ?? null : null);
    setPrefill(open ? initialPrefill : undefined);
    setAddingConnection(open && initialPrefill ? true : null);
    setAccountSectionOpen(!!projectId);
  }

  const selectedConnections = connections?.filter((connection) => connection.providerId === selectedProviderId) ?? [];
  const managing = selectedConnections.length > 0 && !addingConnection;
  const selectedName = selectedProviderId === CUSTOM_PROVIDER_ID
    ? prefill?.label ?? "Custom MCP server"
    : selectedProviderId ? getProvider(selectedProviderId)?.displayName ?? selectedProviderId : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            {projectId
              ? "Connect services and link them to this project."
              : "Connect external services so your agent can use their tools."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!!connections?.length && (
            <Collapsible open={accountSectionOpen} onOpenChange={setAccountSectionOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="text-xs">
                  <ChevronDownIcon aria-hidden="true" className={accountSectionOpen ? "rotate-180" : ""} />
                  {projectId ? "Project and account connections" : "Your connections"} ({connections.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-3">
                {projectId && (
                  <section aria-label="Project connections" className="space-y-2">
                    <h3 className="text-xs font-medium text-muted-foreground">Linked to this project</h3>
                    <ProjectConnectionsPanel projectId={projectId} />
                  </section>
                )}
                <section aria-label="Account connections" className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Your connections</h3>
                  {connections.map((connection) => <ConnectionCard key={connection._id} connection={connection} />)}
                </section>
              </CollapsibleContent>
            </Collapsible>
          )}

          {selectedProviderId ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to provider list"
                  onClick={() => { setSelectedProviderId(null); setPrefill(undefined); setAddingConnection(null); }}
                >
                  <ArrowLeftIcon aria-hidden="true" />
                </Button>
                <h3 className="text-sm font-medium">{managing ? "Manage" : "Add"} {selectedName}</h3>
              </div>
              {connections === undefined ? (
                <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" /> Loading connections...
                </p>
              ) : managing ? (
                <>
                  {selectedConnections.map((connection) => <ConnectionCard key={connection._id} connection={connection} />)}
                  <Button type="button" variant="outline" size="sm" onClick={() => setAddingConnection(true)}>Add another connection</Button>
                </>
              ) : (
                <ConnectApiKeyForm
                  providerId={selectedProviderId}
                  projectId={projectId}
                  prefill={selectedProviderId === CUSTOM_PROVIDER_ID ? prefill : undefined}
                />
              )}
            </section>
          ) : (
            <ProviderCatalog
              onSelect={(providerId, communityPrefill) => {
                setSelectedProviderId(providerId);
                setPrefill(communityPrefill);
                setAddingConnection(communityPrefill ? true : null);
              }}
              connectedProviderIds={connections?.map((connection) => connection.providerId)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
