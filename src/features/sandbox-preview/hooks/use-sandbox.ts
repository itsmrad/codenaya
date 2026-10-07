import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildFlatFileList,
  getChangedFiles,
} from "@/features/sandbox-preview/utils/file-tree";
import {
  classifySandboxError,
  type SandboxErrorKind,
} from "@/features/sandbox-preview/utils/sandbox-error";

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
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<SandboxErrorKind | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [prevEnabled, setPrevEnabled] = useState(enabled);

  // Reset preview state as soon as the preview is disabled
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (!enabled) {
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);
      setErrorKind(null);
    }
  }

  const sandboxIdRef = useRef<string | null>(null);
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const syncPromiseRef = useRef<Promise<void>>(Promise.resolve());
  /** Path → content the sandbox already has, so a sync only sends real edits. */
  const syncedContentRef = useRef(new Map<string, string>());

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
      try {
        setStatus("booting");
        setError(null);
        setTerminalOutput("");

        const flatFiles = buildFlatFileList(files);
        syncedContentRef.current = new Map(
          flatFiles.map((file) => [file.path, file.content]),
        );

        const response = await fetch("/api/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: flatFiles,
            settings,
            projectId,
          }),
          signal: abortController.signal,
        });

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
                case "output":
                  setTerminalOutput((prev) => prev + event.data);
                  break;
                case "ready":
                  sandboxIdRef.current = event.sandboxId;
                  setPreviewUrl(event.previewUrl);
                  setStatus("running");
                  break;
                case "error":
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
      } catch (error) {
        if ((error as Error).name === "AbortError") return;

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

  // Sync file changes to the running sandbox (hot-reload)
  useEffect(() => {
    const sandboxId = sandboxIdRef.current;
    if (!sandboxId || !files || status !== "running") return;

    // Debounce the file sync to batch rapid AI file generations into a single update
    const timeoutId = setTimeout(() => {
      // Only what changed: rewriting e.g. vite.config restarts the dev server
      // and breaks the open preview's HMR connection (#146).
      const changedFiles = getChangedFiles(
        buildFlatFileList(files),
        syncedContentRef.current,
      );

      if (changedFiles.length === 0) return;

      for (const file of changedFiles) {
        syncedContentRef.current.set(file.path, file.content);
      }
  
      // Serialize file syncs to prevent out-of-order writes
      syncPromiseRef.current = syncPromiseRef.current
        .then(() =>
          fetch(`/api/sandbox/${sandboxId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files: changedFiles }),
          })
        )
        .catch(() => {
          // Non-critical — file sync failure shouldn't crash the preview
        })
        .then(); // Return void promise
    }, 1000); // 1-second debounce window

    return () => clearTimeout(timeoutId);
  }, [files, status]);

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
    setError(null);
    setErrorKind(null);
    setTerminalOutput("");
    setRestartKey((k) => k + 1);
  }, [killSandbox]);

  return {
    status,
    previewUrl,
    error,
    errorKind,
    restart,
    terminalOutput,
  };
};
