"use client";

import { useState } from "react";
import { PlugIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionCard } from "@/features/integrations/components/connection-card";
import { IntegrationsDialog } from "@/features/integrations/components/integrations-dialog";
import { useUserConnections } from "@/features/integrations/hooks/use-integrations";

export const IntegrationsSettings = () => {
  const connections = useUserConnections();
  const [dialogOpen, setDialogOpen] = useState(false);

  const renderConnections = () => {
    if (connections === undefined) {
      return (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading connections...
        </div>
      );
    }

    if (connections.length === 0) {
      return (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugIcon />
            </EmptyMedia>
            <EmptyTitle>No connections yet</EmptyTitle>
            <EmptyDescription>
              A connection gives your agent real tools using your own
              credentials. Link it to any of your projects.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
    <Card>
      <CardHeader>
        <CardTitle>Connections</CardTitle>
        <CardDescription>
          Removing a connection unlinks it from every project.
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <PlusIcon aria-hidden="true" />
            Add
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>{renderConnections()}</CardContent>
      <IntegrationsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </Card>
  );
};
