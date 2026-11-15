"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionCard } from "@/features/integrations/components/connection-card";
import { IntegrationsDialog } from "@/features/integrations/components/integrations-dialog";
import { ProviderCatalog } from "@/features/integrations/components/provider-catalog";
import { useUserConnections } from "@/features/integrations/hooks/use-integrations";

export const IntegrationsSettings = () => {
  const connections = useUserConnections();
  const [selectedProviderId, setSelectedProviderId] = useState<string>();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <CardDescription>Connect a service, then link it to any of your projects.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {connections === undefined ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading connections...
          </p>
        ) : connections.length > 0 ? (
          <section aria-label="Your connections" className="space-y-2">
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="group text-xs">
                  <ChevronDownIcon aria-hidden="true" className="group-data-[state=open]:rotate-180" />
                  Your connections ({connections.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-3">
                {connections.map((connection) => <ConnectionCard key={connection._id} connection={connection} />)}
                <p className="text-xs text-muted-foreground">Removing a connection unlinks it from every project.</p>
              </CollapsibleContent>
            </Collapsible>
          </section>
        ) : null}
        <section aria-label="Browse integrations" className="space-y-3">
          <h2 className="text-sm font-medium">Browse integrations</h2>
          <ProviderCatalog
            onSelect={setSelectedProviderId}
            connectedProviderIds={connections?.map((connection) => connection.providerId)}
          />
        </section>
      </CardContent>
      <IntegrationsDialog
        open={selectedProviderId !== undefined}
        onOpenChange={(open) => { if (!open) setSelectedProviderId(undefined); }}
        initialProviderId={selectedProviderId}
      />
    </Card>
  );
};
