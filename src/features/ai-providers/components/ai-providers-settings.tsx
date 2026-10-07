"use client";

import { useState } from "react";
import { KeyRoundIcon, PlusIcon, WalletIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ItemGroup } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

import { useAiPreferences, useAiProviderKeys } from "../hooks/use-ai-providers";
import { AddProviderKeyDialog } from "./add-provider-key-dialog";
import { DefaultModelSelect } from "./default-model-select";
import { ProviderKeyCard } from "./provider-key-card";

const Loading = ({ label }: { label: string }) => (
  <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
    <Spinner className="size-4" />
    {label}
  </div>
);

export const AiProvidersSettings = () => {
  const keys = useAiProviderKeys();
  const preferences = useAiPreferences();
  const [dialogOpen, setDialogOpen] = useState(false);

  const openDialog = () => setDialogOpen(true);

  const renderKeys = () => {
    if (keys === undefined) return <Loading label="Loading keys..." />;

    if (keys.length === 0) {
      return (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No API keys yet</EmptyTitle>
            <EmptyDescription>
              Add a key from OpenRouter, OpenAI, Anthropic or any
              OpenAI-compatible endpoint to run your agent on it.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={openDialog}>
              <PlusIcon aria-hidden="true" />
              Add key
            </Button>
          </EmptyContent>
        </Empty>
      );
    }

    return (
      <ItemGroup aria-label="API keys" className="gap-2">
        {keys.map((key) => (
          <ProviderKeyCard key={key._id} providerKey={key} />
        ))}
      </ItemGroup>
    );
  };

  return (
    <>
      <Alert>
        <WalletIcon aria-hidden="true" />
        <AlertTitle className="line-clamp-none">
          Using your own key consumes no Codenaya credits
        </AlertTitle>
        <AlertDescription>
          The provider bills you directly. If a key stops working, runs that use
          it fail with a link back here. Codenaya never falls back to its own
          key.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Keys are encrypted at rest. Only the last four characters are ever
            shown.
          </CardDescription>
          {keys && keys.length > 0 && (
            <CardAction>
              <Button size="sm" variant="outline" onClick={openDialog}>
                <PlusIcon aria-hidden="true" />
                Add key
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>{renderKeys()}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default model</CardTitle>
          <CardDescription>
            The model new agent runs start with.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys === undefined || preferences === undefined ? (
            <Loading label="Loading models..." />
          ) : (
            <DefaultModelSelect
              keys={keys}
              defaultKeyId={preferences.defaultKeyId}
              defaultModelId={preferences.defaultModelId}
            />
          )}
        </CardContent>
      </Card>

      <AddProviderKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
};
