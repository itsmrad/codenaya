import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function previewAddressUrl(origin: string, projectId: string, engine: "sandbox" | "webcontainer", browserUrl: string | null) {
  return engine === "webcontainer" ? browserUrl ?? "" : `${origin}/p/${encodeURIComponent(projectId)}/preview`;
}

/** The address and outbound link always use the same owner URL. */
export function PreviewAddress({ url, running, loadingLabel, waitingLabel }: {
  url: string;
  running: boolean;
  loadingLabel: string | null;
  waitingLabel: string | null;
}) {
  return (
    <div className="order-last basis-full @md:order-none @md:basis-auto flex-1 min-w-0 flex items-center gap-1">
      <div className="flex-1 min-w-0 h-9 flex items-center px-3 bg-muted/30 rounded-lg border border-border/50 text-xs text-muted-foreground font-mono">
        {running ? (
          <input aria-label="Preview address" readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="w-full min-w-0 truncate bg-transparent outline-none" />
        ) : <span className="truncate">{loadingLabel ?? waitingLabel}</span>}
      </div>
      <span className="flex" title={running ? "Open in new tab" : "Available once the preview is running"}>
        <Button asChild={running} size="icon" variant="ghost" className="size-8 rounded-md hover:bg-muted" disabled={!running} aria-label={running ? undefined : "Open in new tab"}>
          {running ? (
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab"><ExternalLinkIcon className="size-4" /></a>
          ) : <ExternalLinkIcon className="size-4" />}
        </Button>
      </span>
    </div>
  );
}
