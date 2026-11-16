import { useCallback, useEffect, useRef, useState } from "react";
import type { EsbuildRecoveryStatus } from "../utils/esbuild-recovery";

import {
  buildFlatFileList,
  getChangedFiles,
} from "@/features/sandbox-preview/utils/file-tree";
import {
  isBootPhase,
  recordBootPhase,
  type BootHistory,
  type BootPhase,
} from "@/features/sandbox-preview/utils/boot-phase";
import {
  createBuildErrorDetector,
  isHmrSuccess,
  mergeAppError,
  readInstallFailure,
  type AppError,
} from "@/features/sandbox-preview/utils/app-error";
import {
  classifySandboxError,
  type SandboxErrorKind,
} from "@/features/sandbox-preview/utils/sandbox-error";
import {
  BOOT_OUT_OF_TIME,
  afterBootStream,
} from "@/features/sandbox-preview/utils/boot-stream-end";

import { detectFrameworkFromFiles } from "@/features/sandbox-preview/utils/dev-command";

import { Id, Doc } from "../../../../convex/_generated/dataModel";

const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the preview sandbox. Check your connection and retry.";

class SandboxStartError extends Error {
  constructor(
    message: string,
    readonly kind: SandboxErrorKind,
  ) {
    super(message);
  }
}

interface UseSandboxProps {
  files?: Doc<"files">[];
  enabled: boolean;
  /**
   * When set, the project's environment variables are injected into the sandbox.
   * Optional so the hook still works for a preview with no project context.
   */
  projectId?: Id<"projects">;
  settings?: {
    installCommand?: string;
    devCommand?: string;
  };
}

export const useSandbox = ({
  files,
  enabled,
  projectId,
  settings,
}: UseSandboxProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<SandboxErrorKind | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");
  /** A compile error the dev server printed after boot (#223). */
  const [appError, setAppError] = useState<AppError | null>(null);
  // Snapshot acknowledged by the sandbox, including an awaited PATCH reinstall.
  const [syncedFiles, setSyncedFiles] = useState<Doc<"files">[] | undefined>();
  const [buildErrors] = useState(createBuildErrorDetector);
  const [bootHistory, setBootHistory] = useState<BootHistory>({});
  const [phase, setPhase] = useState<BootPhase | null>(null);
  const [prevEnabled, setPrevEnabled] = useState(enabled);

  // Reset preview state as soon as the preview is disabled
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (!enabled) {
      setStatus("idle");
      setPreviewUrl(null);
      setSandboxId(null);
      setError(null);
      setErrorKind(null);
      setAppError(null);
      setPhase(null);
      setBootHistory({});
    }
  }

  const sandboxIdRef = useRef<string | null>(null);
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const syncPromiseRef = useRef<Promise<void>>(Promise.resolve());
  // Runs a debounced or retrying file sync now, so recovery can queue behind it (#776).
  const flushSyncRef = useRef<(() => void) | null>(null);
  /** Path → content the sandbox already has, so a sync only sends real edits. */
  const syncedContentRef = useRef(new Map<string, string>());
  const bootFrameworkRef = useRef<ReturnType<typeof detectFrameworkFromFiles>>(null);

  /**
   * Kill the current sandbox. Uses fetch with keepalive for reliability
   * during page unload, and falls back to sendBeacon.
   */
  const killSandbox = useCallback(async (sandboxId: string) => {
    try {
      await fetch(`/api/sandbox/${sandboxId}`, {
        method: "DELETE",
        keepalive: true,
      });
    } catch {
      // Best-effort — sandbox will auto-expire after 1 hour anyway
    }
  }, []);

  /**
   * Boot the sandbox: create, write files, install, start dev server.
   * Reads the NDJSON stream for real-time terminal output.
   */
  useEffect(() => {
    if (!enabled || !files || files.length === 0 || hasStartedRef.current) {
      return;
    }

    hasStartedRef.current = true;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const start = async () => {
      let ready = false;
      try {
        buildErrors.reset();
        setStatus("booting");
        setError(null);
        setTerminalOutput("");
        setPhase(null);
        setBootHistory({});

        const flatFiles = buildFlatFileList(files);
        bootFrameworkRef.current = detectFrameworkFromFiles(flatFiles);
        syncedContentRef.current = new Map(
          flatFiles.map((file) => [file.path, file.content]),
        );

        // A boot that runs out of server time continues on the same sandbox (#492).
        let resumeSandboxId: string | undefined;
        for (let resumes = 0; ; resumes++) {
          const response = await fetch("/api/sandbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              files: flatFiles,
              settings,
              projectId,
              resumeSandboxId,
            }),
            signal: abortController.signal,
          });
          resumeSandboxId = undefined;

          if (!response.ok) {
            const errorBody = await response.json().catch(() => null);
            throw new SandboxStartError(
              errorBody?.error || `Failed to create sandbox (${response.status})`,
              classifySandboxError({
                code: errorBody?.code,
                status: response.status,
              }),
            );
          }

          // Parse NDJSON stream
          const reader = response.body?.getReader();
          if (!reader) throw new Error("No response stream");

          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            for (const line of lines) {
              if (!line.trim()) continue;

              try {
                const event = JSON.parse(line);

                switch (event.type) {
                  case "status":
                    setStatus(event.status);
                    break;
                  case "output": {
                    setTerminalOutput((prev) => prev + event.data);
                    if (isHmrSuccess(event.data)) {
                      setAppError(null);
                      buildErrors.reset();
                    }
                    const buildError = buildErrors.push(event.data);
                    if (buildError) setAppError((prev) => mergeAppError(prev, buildError));
                    break;
                  }
                  case "phase":
                    if (isBootPhase(event.phase)) {
                      setPhase(event.phase);
                      setBootHistory((history) => recordBootPhase(history, event.phase, event.at));
                    }
                    break;
                  case "ready":
                    ready = true;
                    sandboxIdRef.current = event.sandboxId;
                    setSandboxId(event.sandboxId);
                    setPreviewUrl(event.previewUrl);
                    setStatus("running");
                    break;
                  case "resume":
                    resumeSandboxId = event.sandboxId;
                    // So unmount and restart still kill it between requests.
                    sandboxIdRef.current = event.sandboxId;
                    break;
                  case "error":
                    if (ready) {
                      setError(event.message);
                      setErrorKind(classifySandboxError({ code: event.code }));
                      setStatus("error");
                      break;
                    }
                    throw new SandboxStartError(
                      event.message,
                      classifySandboxError({ code: event.code }),
                    );
                }
              } catch (parseError) {
                // If it's a re-thrown error from "error" event, propagate it
                if (parseError instanceof Error && parseError.message !== line) {
                  throw parseError;
                }
                // Otherwise skip malformed JSON line
              }
            }
          }

          const next = afterBootStream({ ready, resumeSandboxId, resumes });
          if (next === "done") return;
          if (next === "failed") {
            throw new SandboxStartError(BOOT_OUT_OF_TIME, "transient");
          }
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        // The log stream dropped after boot; the preview itself still runs (#492).
        if (ready) {
          setTerminalOutput((prev) => prev + "\nLog stream disconnected. The preview keeps running.\n");
          return;
        }

        setError(
          // fetch and stream reads reject with a bare TypeError ("Failed to
          // fetch", "network error") when the connection drops.
          error instanceof TypeError
            ? NETWORK_ERROR_MESSAGE
            : error instanceof Error
              ? error.message
              : "Unknown error",
        );
        setErrorKind(
          error instanceof SandboxStartError ? error.kind : "transient",
        );
        setStatus("error");
      }
    };

    start();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    files,
    restartKey,
    settings?.devCommand,
    settings?.installCommand,
  ]);

  // Restart: kill existing sandbox and trigger a fresh boot
  const restart = useCallback(() => {
    const sandboxId = sandboxIdRef.current;
    if (sandboxId) {
      killSandbox(sandboxId);
      sandboxIdRef.current = null;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    hasStartedRef.current = false;
    setStatus("idle");
    setPreviewUrl(null);
    setSandboxId(null);
    setError(null);
    setErrorKind(null);
    setAppError(null);
    buildErrors.reset();
    setTerminalOutput("");
    setPhase(null);
    setBootHistory({});
    setRestartKey((k) => k + 1);
  }, [killSandbox, buildErrors]);

  // Sync file changes to the running sandbox (hot-reload)
  useEffect(() => {
    const sandboxId = sandboxIdRef.current;
    const signal = abortControllerRef.current?.signal;
    if (!enabled || !sandboxId || !files || status !== "running" || !signal) return;

    let cancelled = false;
    let failures = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    const isCurrent = () => !signal.aborted && sandboxIdRef.current === sandboxId;

    let pending = false;
    const schedule = (delay: number) => {
      pending = true;
      timeoutId = setTimeout(sync, delay);
    };
    const sync = () => {
      pending = false;
      // Calculate the diff after earlier writes finish, so a queued edit cannot
      // mistake an unacknowledged write for content the sandbox already has.
      syncPromiseRef.current = syncPromiseRef.current.then(async () => {
        if (cancelled || !isCurrent()) return;
        const flatFiles = buildFlatFileList(files);
        const framework = detectFrameworkFromFiles(flatFiles);
        // Reinstall copies the old dev command/env and leaves the proxy on its
        // original port. Reuse Restart so both are recomputed for the new app.
        if (framework && framework !== bootFrameworkRef.current) {
          restart();
          return;
        }
        const changedFiles = getChangedFiles(flatFiles, syncedContentRef.current);
        if (changedFiles.length === 0) {
          setSyncedFiles(files);
          return;
        }

        // The dev server reports the error again if this edit doesn't fix it.
        setAppError(null);
        buildErrors.reset();
        try {
          const response = await fetch(`/api/sandbox/${sandboxId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              files: changedFiles,
              installCommand: settings?.installCommand,
              devCommand: settings?.devCommand,
            }),
            signal,
          });
          const body = await response.json().catch(() => null);
          if (body?.code === "dev_server_unavailable" && isCurrent()) {
            setError(body.error);
            setErrorKind("transient");
            setStatus("error");
            return;
          }
          if (!response.ok) throw new Error("File sync failed");
          if (!isCurrent()) return;
          // Acknowledge exactly the sent snapshot, never files edited in flight.
          for (const file of changedFiles) {
            syncedContentRef.current.set(file.path, file.content);
          }

          // After the boot stream ends, a failed reinstall reaches only this (#497).
          const failure = readInstallFailure(
            body,
            settings?.installCommand || "npm install",
          );
          // Not `cancelled`: edits during a slow reinstall must not hide its failure.
          if (!isCurrent()) return;
          setSyncedFiles(files);
          if (!failure) return;
          setTerminalOutput((prev) => `${prev}\npackage.json changed.\n${failure.output}`);
          const { error } = failure;
          if (error) setAppError((prev) => mergeAppError(prev, error));
        } catch {
          // The write may have landed anyway, so a revert must still be resent.
          if (sandboxIdRef.current === sandboxId) {
            for (const file of changedFiles) syncedContentRef.current.delete(file.path);
          }
          if (cancelled || !isCurrent()) return;
          if (failures < 3) {
            schedule(1_000 * 2 ** failures++);
          } else {
            setError("Couldn't sync preview files. Restart the preview to retry.");
            setErrorKind("transient");
            setStatus("error");
          }
        }
      });
    };
    // Debounce rapid file generations; a new files snapshot cancels old retries.
    schedule(300);
    flushSyncRef.current = () => {
      if (!pending) return;
      clearTimeout(timeoutId);
      sync();
    };
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      flushSyncRef.current = null;
    };
  }, [enabled, files, status, settings?.installCommand, settings?.devCommand, buildErrors, restart]);

  // Cleanup sandbox on unmount or when disabled
  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;

      // Kill sandbox if one exists
      const sandboxId = sandboxIdRef.current;
      if (sandboxId) {
        killSandbox(sandboxId);
        sandboxIdRef.current = null;
      }

      // Abort any in-flight stream
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    }
  }, [enabled, killSandbox]);

  // Kill sandbox on page unload (tab close / navigation)
  useEffect(() => {
    const handleBeforeUnload = () => {
      const sandboxId = sandboxIdRef.current;
      if (sandboxId) {
        // sendBeacon is the most reliable way to fire during unload
        navigator.sendBeacon(`/api/sandbox/${sandboxId}?_method=DELETE`);
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);

      // Also kill on component unmount
      const sandboxId = sandboxIdRef.current;
      if (sandboxId) {
        killSandbox(sandboxId);
        sandboxIdRef.current = null;
      }

      abortControllerRef.current?.abort();
      // Let a remount (React Strict Mode in dev) boot again instead of waiting
      // forever on the stream this cleanup just aborted.
      hasStartedRef.current = false;
    };
  }, [killSandbox]);

  // Source/package syncs finish first, so this tab cannot restart during its install (#776).
  const recoverDevServer = useCallback(() => {
    const sandboxId = sandboxIdRef.current;
    flushSyncRef.current?.();
    const recovery = syncPromiseRef.current.then(async (): Promise<EsbuildRecoveryStatus> => {
      const signal = abortControllerRef.current?.signal;
      if (!sandboxId || !signal || signal.aborted || sandboxIdRef.current !== sandboxId) return "unavailable";
      const response = await fetch(`/api/sandbox/${sandboxId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover-esbuild" }),
        signal,
      });
      if (!response.ok) throw new Error("Preview recovery failed");
      const { status } = await response.json();
      if (!["restarted", "busy", "limited", "unavailable"].includes(status)) throw new Error("Invalid recovery response");
      if (status === "restarted" && !signal.aborted && sandboxIdRef.current === sandboxId) {
        buildErrors.reset();
        setAppError(null);
        setTerminalOutput((prev) => `${prev}\nPreview dev server recovered automatically.\n`);
      }
      return status;
    });
    // A failed recovery must not block later file syncs.
    syncPromiseRef.current = recovery.then(() => {}, () => {});
    return recovery;
  }, [buildErrors]);

  return {
    sandboxId,
    recoverDevServer,
    status,
    previewUrl,
    error,
    errorKind,
    appError,
    syncedFiles,
    restart,
    terminalOutput,
    phase,
    bootHistory,
  };
};
