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
  LockIcon,
} from "lucide-react";

import { useSandbox } from "@/features/sandbox-preview/hooks/use-sandbox";
import { useWebContainer } from "@/features/webcontainer-preview/hooks/use-webcontainer";
import { PreviewSettingsPopover } from "@/features/sandbox-preview/components/preview-settings-popover";
import { PreviewTerminal } from "@/features/sandbox-preview/components/preview-terminal";
import {
  PREVIEW_DEVICE_WIDTHS,
  PreviewDeviceToggle,
  usePreviewDevice,
  type PreviewDevice,
} from "@/features/sandbox-preview/components/preview-device-toggle";
import type { SandboxErrorKind } from "@/features/sandbox-preview/utils/sandbox-error";

import { Button } from "@/components/ui/button";

import { EnvVarsDialog } from "./env-vars-dialog";
import { useProject } from "../hooks/use-projects";
import { useFiles } from "../hooks/use-files";
import {
  usePublicEnvVars,
  useWithheldSecretCount,
} from "@/features/integrations/hooks/use-integrations";
import { usePathname, useSearchParams } from "next/navigation";

import { Id } from "../../../../convex/_generated/dataModel";

type PreviewEngine = "sandbox" | "webcontainer";

export const PreviewView = ({ projectId }: { projectId: Id<"projects"> }) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const project = useProject(projectId);
  const files = useFiles(projectId);
  const [showTerminal, setShowTerminal] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [device, setDevice] = usePreviewDevice();
  
  // URL dictates isolation mode via next.config.ts conditional headers
  const engineParam = searchParams.get("engine") as PreviewEngine | null;
  const activeEngine = engineParam === "webcontainer" ? "webcontainer" : "sandbox";

  const sandbox = useSandbox({
    files,
    enabled: activeEngine === "sandbox",
    projectId,
    settings: project?.settings,
  });

  // WebContainer runs in this page, so it receives only variables already destined
  // for the client bundle. Secrets go to the E2B sandbox, which runs server-side.
  const publicEnv = usePublicEnvVars(projectId);
  const withheldSecretCount = useWithheldSecretCount(projectId);

  const webcontainer = useWebContainer({
    files,
    enabled: activeEngine === "webcontainer",
    publicEnv,
    settings: project?.settings,
  });

  const activeInstance = activeEngine === "sandbox" ? sandbox : webcontainer;
  const { status, previewUrl, error, restart, terminalOutput } = activeInstance;
  const errorKind = activeEngine === "sandbox" ? sandbox.errorKind : null;

  // Only ever called from a user action. WebContainer needs the COOP/COEP headers
  // next.config.ts sets for `?engine=webcontainer`, so switching is a full page
  // load; doing it automatically on a sandbox error turned config errors into a
  // silent reload with no explanation.
  const switchEngine = useCallback((newEngine: PreviewEngine) => {
    if (newEngine === activeEngine) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("engine", newEngine);
    params.set("view", "preview");
    window.location.href = `${pathname}?${params.toString()}`;
  }, [activeEngine, pathname, searchParams]);

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
      {/* Secrets are withheld from WebContainer because it boots in this page, so
          anything mounted there is readable by the end user. Saying so explicitly
          beats letting the generated app fail with a confusing runtime error the
          user cannot trace back to a preview-engine choice. */}
      {activeEngine === "webcontainer" && (withheldSecretCount ?? 0) > 0 && (
        <div
          role="status"
          className="shrink-0 flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] text-xs"
        >
          <LockIcon
            aria-hidden="true"
            className="size-3.5 mt-0.5 shrink-0 text-amber-500"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {withheldSecretCount} secret{withheldSecretCount === 1 ? "" : "s"} not
              available in this preview
            </p>
            <p className="text-muted-foreground mt-0.5 leading-relaxed">
              This preview runs in your browser, so secret values are withheld —
              anything sent here would be readable by anyone who opens the page.
              Switch to Cloud Sandbox to run with full credentials.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={() => switchEngine("sandbox")}
          >
            Use Cloud Sandbox
          </Button>
        </div>
      )}
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
              aria-label="Sandbox"
            >
              <ServerIcon className="size-3.5" />
              <span className="text-xs hidden @3xl:inline">Sandbox</span>
            </Button>
            <Button
              size="sm"
              variant={activeEngine === "webcontainer" ? "secondary" : "ghost"}
              className="h-8 rounded-md px-2 space-x-1 shadow-none"
              onClick={() => switchEngine("webcontainer")}
              title="Use in-browser WebContainers"
              aria-label="WebContainer"
            >
              <BoxIcon className="size-3.5" />
              <span className="text-xs hidden @3xl:inline">WebContainer</span>
            </Button>
        </div>

        <PreviewDeviceToggle device={device} onChange={setDevice} />

        <div className="flex-1 min-w-0 h-9 flex items-center px-3 bg-muted/30 rounded-lg border border-border/50 text-xs text-muted-foreground truncate font-mono">
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
          <EnvVarsDialog projectId={projectId} />
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
        {showTerminal ? (
          <Allotment
            key="preview-with-terminal"
            vertical
            defaultSizes={[300, 150]}
          >
            <Allotment.Pane minSize={100}>
              <div className="size-full pb-1.5">
                <PreviewContent
                  error={error}
                  isLoading={isLoading}
                  status={status}
                  activeEngine={activeEngine}
                  previewUrl={previewUrl}
                  refreshKey={refreshKey}
                  device={device}
                  restart={restart}
                  errorKind={errorKind}
                  onUseWebContainer={() => switchEngine("webcontainer")}
                />
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={100} maxSize={500} preferredSize={200}>
              <div className="size-full pt-1.5">
                <div className="size-full rounded-xl bg-background border border-border/50 shadow-sm overflow-hidden flex flex-col">
                  <div className="h-9 flex items-center px-4 text-xs font-medium gap-1.5 text-muted-foreground border-b border-border/50 shrink-0 bg-muted/20">
                    <TerminalSquareIcon className="size-4" />
                    Terminal
                  </div>
                  <PreviewTerminal output={terminalOutput} />
                </div>
              </div>
            </Allotment.Pane>
          </Allotment>
        ) : (
          <div className="size-full">
            <PreviewContent
              error={error}
              isLoading={isLoading}
              status={status}
              activeEngine={activeEngine}
              previewUrl={previewUrl}
              refreshKey={refreshKey}
              device={device}
              restart={restart}
              errorKind={errorKind}
              onUseWebContainer={() => switchEngine("webcontainer")}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const ERROR_TITLES: Record<SandboxErrorKind, string> = {
  config: "Cloud sandbox isn't available",
  rate_limit: "Cloud sandbox limit reached",
  transient: "Preview failed to start",
};

const PreviewContent = ({
  error,
  isLoading,
  status,
  activeEngine,
  previewUrl,
  refreshKey,
  device,
  restart,
  errorKind,
  onUseWebContainer,
}: {
  error: string | null | undefined;
  isLoading: boolean;
  status: string;
  activeEngine: PreviewEngine;
  previewUrl: string | null | undefined;
  refreshKey: number;
  device: PreviewDevice;
  restart: () => void;
  errorKind: SandboxErrorKind | null;
  onUseWebContainer: () => void;
}) => (
  <div className="size-full rounded-xl overflow-hidden relative isolate">
    <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-border/50 pointer-events-none z-50" />

    {error && (
      <div className="size-full flex items-center justify-center text-muted-foreground bg-background p-4">
        <div
          role="alert"
          className="flex flex-col items-center gap-2 max-w-md mx-auto text-center"
        >
          <AlertTriangleIcon className="size-6" />
          <p className="text-sm font-medium text-foreground">
            {ERROR_TITLES[errorKind ?? "transient"]}
          </p>
          <p className="text-xs leading-relaxed">{error}</p>
          <div className="flex flex-wrap justify-center gap-2 mt-1">
            <Button size="sm" variant="outline" onClick={restart}>
              <RefreshCwIcon className="size-4" />
              Retry
            </Button>
            {activeEngine === "sandbox" && (
              <Button size="sm" onClick={onUseWebContainer}>
                <BoxIcon className="size-4" />
                Use in-browser preview
              </Button>
            )}
          </div>
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
      <div className="size-full flex justify-center bg-muted/30">
        <iframe
          key={refreshKey}
          src={previewUrl}
          className="h-full w-full max-w-full border-0 bg-background data-[framed=true]:border-x data-[framed=true]:border-border/50"
          style={{ width: PREVIEW_DEVICE_WIDTHS[device] ?? undefined }}
          data-framed={device !== "desktop"}
          title="Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          allow="cross-origin-isolated"
        />
      </div>
    )}
  </div>
);

