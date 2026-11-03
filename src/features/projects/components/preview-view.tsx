"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Allotment } from "allotment";
import { motion, useReducedMotion } from "motion/react";
import {
  ChevronDownIcon,
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
import { OpenOnPhonePopover } from "@/features/sandbox-preview/components/open-on-phone-popover";
import { PreviewTerminal } from "@/features/sandbox-preview/components/preview-terminal";
import { PreviewBuilding } from "@/features/sandbox-preview/components/preview-building";
import { CodenayaLogo } from "@/components/codenaya-logo";
import { PreviewBootSteps } from "@/features/sandbox-preview/components/preview-boot-steps";
import {
  PreviewStatusBadge,
  PreviewTerminalStrip,
  usePreviewTerminal,
} from "@/features/sandbox-preview/components/preview-terminal-strip";
import {
  PREVIEW_DEVICE_WIDTHS,
  PreviewDeviceToggle,
  usePreviewDevice,
  type PreviewDevice,
} from "@/features/sandbox-preview/components/preview-device-toggle";
import type { SandboxErrorKind } from "@/features/sandbox-preview/utils/sandbox-error";
import { hasRootPackageJson } from "@/features/sandbox-preview/utils/file-tree";
import type { BootHistory, BootPhase } from "@/features/sandbox-preview/utils/boot-phase";
import { NOTHING_TO_PREVIEW } from "@/features/sandbox-preview/utils/boot-plan";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { EnvVarsDialog } from "./env-vars-dialog";
import { useProject } from "../hooks/use-projects";
import { useFilesWithContent } from "../hooks/use-files";
import { markPreviewOpened } from "../utils/first-run";
import { useActiveRun } from "@/features/conversations/hooks/use-conversations";
import {
  usePublicEnvVars,
  useWithheldSecretCount,
} from "@/features/integrations/hooks/use-integrations";
import { usePathname, useSearchParams } from "next/navigation";

import { Id } from "../../../../convex/_generated/dataModel";

type PreviewEngine = "sandbox" | "webcontainer";

const WAITING_FOR_BUILD = "Waiting for the first build...";

/** What the collapsed terminal shows until the engine writes its first line. */
const stripPlaceholder = (building: boolean, isLoading: boolean) => {
  if (building) return WAITING_FOR_BUILD;
  if (isLoading) return "Starting...";
  return "No output yet";
};

export const PreviewView = ({
  projectId,
  firstBuild,
}: {
  projectId: Id<"projects">;
  /** The agent is writing a new project's first build (see ProjectIdView). */
  firstBuild: boolean;
}) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  
  const project = useProject(projectId);
  const files = useFilesWithContent(projectId);
  const [terminalChoice, setTerminalChoice] = usePreviewTerminal();
  const [refreshKey, setRefreshKey] = useState(0);
  const [device, setDevice] = usePreviewDevice();
  
  // URL dictates isolation mode via next.config.ts conditional headers
  const engineParam = searchParams.get("engine") as PreviewEngine | null;
  const activeEngine = engineParam === "webcontainer" ? "webcontainer" : "sandbox";

  // During the first build the E2B sandbox boots as soon as package.json
  // exists, so it is warm when the run ends: later files reach it through the
  // file sync, and a changed package.json re-runs the install (#254).
  // WebContainer doesn't re-install, so it still waits for the run to end.
  const activeRun = useActiveRun(projectId);
  const hasPackageJson = files ? hasRootPackageJson(files) : false;
  const holdSandbox = activeRun === undefined || (firstBuild && !hasPackageJson);
  const holdWebContainer = activeRun === undefined || firstBuild;

  const sandbox = useSandbox({
    files,
    enabled: activeEngine === "sandbox" && !holdSandbox,
    projectId,
    settings: project?.settings,
  });

  // WebContainer runs in this page, so it receives only variables already destined
  // for the client bundle. Secrets go to the E2B sandbox, which runs server-side.
  const publicEnv = usePublicEnvVars(projectId);
  const withheldSecretCount = useWithheldSecretCount(projectId);

  const webcontainer = useWebContainer({
    files,
    enabled: activeEngine === "webcontainer" && !holdWebContainer,
    publicEnv,
    settings: project?.settings,
  });

  const activeInstance = activeEngine === "sandbox" ? sandbox : webcontainer;
  const { status, previewUrl, error, restart, terminalOutput } = activeInstance;
  const errorKind = activeEngine === "sandbox" ? sandbox.errorKind : null;
  // WebContainer has no phase events: booting covers creating it and writing
  // the files, installing covers the install and starting the dev server.
  const bootPhase: BootPhase | null =
    activeEngine === "sandbox"
      ? sandbox.phase
      : webcontainer.status === "installing"
        ? "install"
        : "create";
  const reduceMotion = useReducedMotion();

  // A failed start opens the terminal even when the user keeps it closed, but
  // that isn't saved as their choice: closing it again only lasts for this error.
  const [errorDismissed, setErrorDismissed] = useState(false);
  if (errorDismissed && status !== "error") setErrorDismissed(false);
  const showTerminal =
    terminalChoice === "open" || (status === "error" && !errorDismissed);
  const toggleTerminal = () => {
    if (!showTerminal) return setTerminalChoice("open");
    setTerminalChoice("closed");
    if (status === "error") setErrorDismissed(true);
  };

  // A boot that started mid-build can fail on files the agent hadn't written
  // yet; boot once more against the finished build.
  const wasFirstBuild = useRef(firstBuild);
  useEffect(() => {
    if (wasFirstBuild.current && !firstBuild && status === "error") restart();
    wasFirstBuild.current = firstBuild;
  }, [firstBuild, status, restart]);

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
  const building =
    firstBuild && activeRun && files ? (
      <PreviewBuilding steps={activeRun.steps} files={files} />
    ) : null;
  const content = (
    <PreviewContent
      error={error}
      isLoading={isLoading}
      bootPhase={bootPhase}
      bootHistory={sandbox.bootHistory}
      terminalOutput={terminalOutput}
      activeEngine={activeEngine}
      previewUrl={previewUrl}
      refreshKey={refreshKey}
      device={device}
      restart={restart}
      errorKind={errorKind}
      onUseWebContainer={() => switchEngine("webcontainer")}
      agentWorking={Boolean(activeRun)}
      building={building}
    />
  );

  // Ticks the dashboard's "Open the preview" step.
  useEffect(() => {
    if (previewUrl) markPreviewOpened();
  }, [previewUrl]);

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
      <div className="p-1.5 shrink-0 border border-border/50 rounded-xl bg-background shadow-sm flex flex-wrap items-center gap-2">
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

        {/* A phone-width panel is already a phone-sized frame. */}
        <div className="hidden @md:block">
          <PreviewDeviceToggle device={device} onChange={setDevice} />
        </div>

        {/* Narrow panels give the URL its own row. */}
        <div className="order-last basis-full @md:order-none @md:basis-auto flex-1 min-w-0 h-9 flex items-center px-3 bg-muted/30 rounded-lg border border-border/50 text-xs text-muted-foreground truncate font-mono">
          {isLoading && (
            <div className="flex items-center gap-1.5">
              <Loader2Icon className="size-3 animate-spin" />
              {status === "booting" ? `Starting ${activeEngine}...` : "Installing..."}
            </div>
          )}
          {previewUrl && <span className="truncate">{previewUrl}</span>}
          {!isLoading && !previewUrl && !error && (
            <span>{building ? WAITING_FOR_BUILD : "Ready to preview"}</span>
          )}
        </div>

        <div className="flex items-center gap-1 p-0.5 bg-muted/40 rounded-lg border border-border/50">
          {/* A real link rather than window.open, so the browser treats it as a
              plain navigation (no popup heuristics; middle-click and copy-link
              work). The span carries the tooltip: a disabled button gets no hover. */}
          <span
            className="flex"
            title={previewUrl ? "Open in new tab" : "Available once the preview is running"}
          >
            {previewUrl ? (
              <Button
                asChild
                size="icon"
                variant="ghost"
                className="size-8 rounded-md hover:bg-muted"
              >
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open in new tab"
                >
                  <ExternalLinkIcon className="size-4" />
                </a>
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="size-8 rounded-md hover:bg-muted"
                disabled
                aria-label="Open in new tab"
              >
                <ExternalLinkIcon className="size-4" />
              </Button>
            )}
          </span>
          <OpenOnPhonePopover
            previewUrl={previewUrl}
            status={status}
            activeEngine={activeEngine}
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 rounded-md hover:bg-muted"
            title={showTerminal ? "Hide logs" : "Show logs"}
            aria-label="Toggle terminal"
            aria-pressed={showTerminal}
            onClick={toggleTerminal}
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
                {content}
              </div>
            </Allotment.Pane>

            <Allotment.Pane minSize={100} maxSize={500} preferredSize={200}>
              <div className="size-full pt-1.5">
                <motion.div
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className={cn(
                    "size-full rounded-xl bg-background border border-border/50 shadow-sm overflow-hidden flex flex-col",
                    status === "error" && "ring-1 ring-destructive/40",
                  )}
                >
                  <div className="h-9 flex items-center pl-4 pr-1.5 text-xs font-medium gap-2 text-muted-foreground border-b border-border/50 shrink-0 bg-muted/20">
                    <TerminalSquareIcon className="size-4" />
                    Terminal
                    <PreviewStatusBadge status={status} />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      aria-expanded={true}
                      onClick={toggleTerminal}
                    >
                      Hide logs
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                  </div>
                  <PreviewTerminal output={terminalOutput} />
                </motion.div>
              </div>
            </Allotment.Pane>
          </Allotment>
        ) : (
          <div className="size-full flex flex-col gap-1.5">
            <div className="flex-1 min-h-0">{content}</div>
            <PreviewTerminalStrip
              status={status}
              output={terminalOutput}
              placeholder={stripPlaceholder(Boolean(building), isLoading)}
              onExpand={toggleTerminal}
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
  bootPhase,
  bootHistory,
  terminalOutput,
  activeEngine,
  previewUrl,
  refreshKey,
  device,
  restart,
  errorKind,
  onUseWebContainer,
  agentWorking,
  building,
}: {
  error: string | null | undefined;
  isLoading: boolean;
  bootPhase: BootPhase | null;
  bootHistory: BootHistory;
  terminalOutput: string;
  activeEngine: PreviewEngine;
  previewUrl: string | null | undefined;
  refreshKey: number;
  device: PreviewDevice;
  restart: () => void;
  errorKind: SandboxErrorKind | null;
  onUseWebContainer: () => void;
  /** Any message is processing: planning, chatting or writing code. */
  agentWorking?: boolean;
  /** The first-build placeholder, shown over the engine until the run ends. */
  building: ReactNode;
}) => (
  <div className="size-full rounded-xl overflow-hidden relative isolate">
    <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-border/50 pointer-events-none z-50" />

    {/* Laid over the engine so a pre-warmed preview loads underneath it. */}
    {building && <div className="absolute inset-0 z-10">{building}</div>}

    {/* Hidden under the first build: PreviewBuilding already says the same. */}
    {agentWorking && !building && (
      <div role="status" className="pointer-events-none absolute top-3 right-3 z-40 flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-card/95 backdrop-blur-md border border-brand/30 shadow-lg text-xs font-medium text-foreground motion-safe:animate-in fade-in-0 duration-200">
        <span className="relative flex size-2">
          <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
          <span className="relative inline-flex rounded-full size-2 bg-brand" />
        </span>
        <CodenayaLogo size={16} blinking={true} decorative />
        <span className="text-[11px] text-muted-foreground font-mono">Agent working</span>
      </div>
    )}

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
            {/* The in-browser engine would fail the same way. */}
            {activeEngine === "sandbox" && error !== NOTHING_TO_PREVIEW && (
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
      <PreviewBootSteps
        key={activeEngine}
        phase={bootPhase}
        history={activeEngine === "sandbox" ? bootHistory : undefined}
        log={terminalOutput}
        firstStepLabel={activeEngine === "webcontainer" ? "Start WebContainer" : undefined}
      />
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

