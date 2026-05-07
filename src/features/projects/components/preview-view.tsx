"use client";

import { useState, useEffect, useCallback } from "react";
import { Allotment } from "allotment";
import {
  Loader2Icon,
  TerminalSquareIcon,
  AlertTriangleIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  RotateCwIcon,
  ServerIcon,
  BoxIcon,
} from "lucide-react";

import { useSandbox } from "@/features/sandbox-preview/hooks/use-sandbox";
import { useWebContainer } from "@/features/webcontainer-preview/hooks/use-webcontainer";
import { PreviewSettingsPopover } from "@/features/sandbox-preview/components/preview-settings-popover";
import { PreviewTerminal } from "@/features/sandbox-preview/components/preview-terminal";

import { Button } from "@/components/ui/button";

import { useProject } from "../hooks/use-projects";
import { useFiles } from "../hooks/use-files";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

import { Id } from "../../../../convex/_generated/dataModel";

type PreviewEngine = "sandbox" | "webcontainer";
const TERMINAL_CLOSE_THRESHOLD = 110;

export const PreviewView = ({ projectId }: { projectId: Id<"projects"> }) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const project = useProject(projectId);
  const files = useFiles(projectId);
  const [showTerminal, setShowTerminal] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  
  // URL dictates isolation mode via next.config.ts conditional headers
  const engineParam = searchParams.get("engine") as PreviewEngine | null;
  const engine = engineParam === "webcontainer" ? "webcontainer" : "sandbox";

  // For auto-fallback handling without hard page reloading loops
  const [fallbackEngine, setFallbackEngine] = useState<PreviewEngine | null>(null);
  const activeEngine = fallbackEngine || engine;

  const sandbox = useSandbox({
    files,
    enabled: activeEngine === "sandbox",
    settings: project?.settings,
  });

  const webcontainer = useWebContainer({
    files,
    enabled: activeEngine === "webcontainer",
    settings: project?.settings,
  });

  const activeInstance = activeEngine === "sandbox" ? sandbox : webcontainer;
  const { status, previewUrl, error, restart, terminalOutput } = activeInstance;

  const switchEngine = useCallback((newEngine: PreviewEngine) => {
    if (newEngine === engine) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("engine", newEngine);
    window.location.href = `${pathname}?${params.toString()}`;
  }, [engine, pathname, searchParams]);

  useEffect(() => {
    if (activeEngine === "sandbox" && sandbox.status === "error") {
      console.warn("Sandbox failed (possibly rate limit), automatically falling back to WebContainers.");
      // We push param so Next.js reloads with COOP/COEP headers
      switchEngine("webcontainer");
    }
  }, [activeEngine, sandbox.status, switchEngine]);

  const isLoading = status === "booting" || status === "installing";

  // Automatically refresh the iframe shortly after the dev server announces it's running.
  // The first request to Vite often serves the index.html and CSS instantly but hangs 
  // compiling the JS bundle. An auto-refresh ensures the JS hydration catches up seamlessly.
  useEffect(() => {
    if (status === "running" && previewUrl) {
      const timer = setTimeout(() => {
        setRefreshKey((k) => k + 1);
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [status, previewUrl]);

  return (
    <div className="h-full flex flex-col bg-transparent gap-3">
      <div className="p-1.5 shrink-0 border border-border/50 rounded-xl bg-background shadow-sm flex items-center gap-2">
        <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/50">
          <Button
            size="icon"
            variant="ghost"
            className="size-8 rounded-md hover:bg-muted"
            disabled={isLoading}
            onClick={restart}
            title={`Restart ${activeEngine}`}
            aria-label={`Restart ${activeEngine}`}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 rounded-md hover:bg-muted"
            disabled={isLoading || !previewUrl}
            onClick={() => setRefreshKey(k => k + 1)}
            title="Refresh page"
            aria-label="Refresh page"
          >
            <RotateCwIcon className="size-4" />
          </Button>
        </div>

        {/* Engine Toggle UI */}
        <div className="flex items-center p-0.5 bg-muted/40 rounded-lg border border-border/50">
            <Button
              size="sm"
              variant={activeEngine === "sandbox" ? "secondary" : "ghost"}
              className="h-8 rounded-md px-2 space-x-1 shadow-none"
              onClick={() => switchEngine("sandbox")}
              title="Use high-fidelity E2B Sandbox"
            >
              <ServerIcon className="size-3.5" />
              <span className="text-xs">Sandbox</span>
            </Button>
            <Button
              size="sm"
              variant={activeEngine === "webcontainer" ? "secondary" : "ghost"}
              className="h-8 rounded-md px-2 space-x-1 shadow-none"
              onClick={() => switchEngine("webcontainer")}
              title="Use in-browser WebContainers"
            >
              <BoxIcon className="size-3.5" />
              <span className="text-xs">WebContainer</span>
            </Button>
        </div>

        <div className="flex-1 h-9 flex items-center px-3 bg-muted/30 rounded-lg border border-border/50 text-xs text-muted-foreground truncate font-mono">
          {isLoading && (
            <div className="flex items-center gap-1.5">
              <Loader2Icon className="size-3 animate-spin" />
              {status === "booting" ? `Starting ${activeEngine}...` : "Installing..."}
            </div>
          )}
          {previewUrl && <span className="truncate">{previewUrl}</span>}
          {!isLoading && !previewUrl && !error && <span>Ready to preview</span>}
        </div>

        <div className="flex items-center gap-1 p-0.5 bg-muted/40 rounded-lg border border-border/50">
          {previewUrl && (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 rounded-md hover:bg-muted"
              title="Open in new tab"
              aria-label="Open in new tab"
              onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-8 rounded-md hover:bg-muted"
            title="Toggle terminal"
            aria-label="Toggle terminal"
            onClick={() => setShowTerminal((value) => !value)}
          >
            <TerminalSquareIcon className="size-4" />
          </Button>
          <div className="px-1 flex items-center">
            <PreviewSettingsPopover
              projectId={projectId}
              initialValues={project?.settings}
              onSave={restart}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <Allotment
          vertical
          onChange={(sizes) => {
            // Auto-close terminal when dragged close to the bottom
            if (showTerminal && sizes[1] !== undefined && sizes[1] <= TERMINAL_CLOSE_THRESHOLD) {
              setShowTerminal(false);
            }
          }}
        >
          <Allotment.Pane>
            <div className={cn("size-full", showTerminal ? "pb-1.5" : "")}>
              {/*
                iframe corner bleed fix:
                - The parent must be TRANSPARENT (no background) with overflow-hidden + border-radius to clip the iframe.
                - Any anti-aliased edge pixels will then blend into the canvas bg instead of creating a visible dark/white halo.
                - The ring overlay is painted on top via z-50 to draw the visible border.
              */}
              <div className="size-full rounded-2xl overflow-hidden relative isolate">
                <div className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-border/50 pointer-events-none z-50" />

                {error && (
                  <div className="size-full flex items-center justify-center text-muted-foreground bg-background">
                    <div className="flex flex-col items-center gap-2 max-w-md mx-auto text-center">
                      <AlertTriangleIcon className="size-6" />
                      <p className="text-sm font-medium">{error}</p>
                      <Button size="sm" variant="outline" onClick={restart}>
                        <RefreshCwIcon className="size-4" />
                        Restart
                      </Button>
                    </div>
                  </div>
                )}

                {isLoading && !error && (
                  <div className="size-full flex items-center justify-center text-muted-foreground bg-background">
                    <div className="flex flex-col items-center gap-2 max-w-md mx-auto text-center">
                      <Loader2Icon className="size-6 animate-spin" />
                      <p className="text-sm font-medium">
                        {status === "booting"
                          ? `Starting ${activeEngine}...`
                          : "Installing dependencies..."}
                      </p>
                    </div>
                  </div>
                )}

                {previewUrl && (
                  <iframe
                    key={refreshKey}
                    src={previewUrl}
                    className="size-full border-0"
                    title="Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    allow="cross-origin-isolated"
                  />
                )}
              </div>
            </div>
          </Allotment.Pane>

          {showTerminal && (
            <Allotment.Pane minSize={100} maxSize={500} preferredSize={200}>
              <div className="size-full pt-1.5">
                <div className="size-full rounded-2xl bg-background border border-border/50 shadow-sm overflow-hidden flex flex-col">
                  <div className="h-9 flex items-center px-4 text-xs font-medium gap-1.5 text-muted-foreground border-b border-border/50 shrink-0 bg-muted/20">
                    <TerminalSquareIcon className="size-4" />
                    Terminal
                  </div>
                  <PreviewTerminal output={terminalOutput} />
                </div>
              </div>
            </Allotment.Pane>
          )}
        </Allotment>
      </div>
    </div>
  );
};

