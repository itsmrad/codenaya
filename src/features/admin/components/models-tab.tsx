"use client";

import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon } from "lucide-react";

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
import { Spinner } from "@/components/ui/spinner";

import { type CatalogDraft, useCatalogDraft } from "../hooks/use-catalog-draft";
import { CatalogCard } from "./catalog-card";
import type { ProviderOption } from "./provider-picker";

/** A platform provider as the server sees it: never the key, only whether it's set. */
interface ProviderKeyStatus extends ProviderOption {
  keyConfigured: boolean;
}

const ProviderKeys = ({ providers }: { providers: ProviderKeyStatus[] }) => (
  <section aria-label="Provider keys" className="flex flex-wrap items-center gap-2 text-sm">
    <span className="mr-1 text-muted-foreground">Provider keys</span>
    {providers.map((p) => (
      <Badge key={p.id} variant="outline" className={p.keyConfigured ? undefined : "text-muted-foreground"}>
        {p.keyConfigured ? <CircleCheckIcon aria-hidden="true" /> : <CircleDashedIcon aria-hidden="true" />}
        {p.label}
        {p.keyConfigured ? <span className="sr-only">set</span> : <span>not set</span>}
      </Badge>
    ))}
  </section>
);

/** Docked to the bottom of the viewport while the catalog has unsaved edits. */
const SaveBar = ({ draft }: { draft: CatalogDraft }) => {
  const blocked = draft.problems.length > 0;

  return (
    <>
      {/* Reserves the bar's height so the end of the page can scroll clear of it. */}
      <div aria-hidden="true" className="h-28 sm:h-16" />
      <div
        role="region"
        aria-label="Unsaved changes"
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm">
            <p className="font-medium">Unsaved changes</p>
            {blocked && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                {draft.problems.join(" · ")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={draft.discard} disabled={draft.saving}>
              Discard
            </Button>
            <Button size="sm" className="flex-1 sm:flex-none" onClick={() => draft.save()} disabled={blocked || draft.saving}>
              {draft.saving && <Spinner />}
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

/** The server refused a $0 or sharply changed price until the admin confirms it. */
const RiskyPricesDialog = ({ draft }: { draft: CatalogDraft }) => (
  <AlertDialog open={draft.riskyNames !== null} onOpenChange={(open) => !open && draft.cancelRiskySave()}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Save these prices?</AlertDialogTitle>
        <AlertDialogDescription>
          A price of $0, or one that moved by more than half, is usually a typo. It changes what
          every run on these models costs us.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {draft.riskyNames && draft.riskyNames.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {/* Names can repeat across routes; the list never reorders. */}
          {draft.riskyNames.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>Review prices</AlertDialogCancel>
        <AlertDialogAction onClick={() => draft.save(true)}>Save anyway</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

export const ModelsTab = ({
  providers,
  fallbackProviderLabel,
}: {
  providers: ProviderKeyStatus[];
  fallbackProviderLabel: string;
}) => {
  const draft = useCatalogDraft();

  return (
    <>
      <ProviderKeys providers={providers} />
      <CatalogCard
        draft={draft}
        providers={providers}
        keyedProviders={providers.filter((p) => p.keyConfigured)}
        fallbackProviderLabel={fallbackProviderLabel}
      />
      {draft.isDirty && <SaveBar draft={draft} />}
      <RiskyPricesDialog draft={draft} />
    </>
  );
};
