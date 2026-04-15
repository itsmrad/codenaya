import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildFlatFileList,
  getFilePath,
} from "@/features/sandbox-preview/utils/file-tree";

import { Id, Doc } from "../../../../convex/_generated/dataModel";

interface UseSandboxProps {
  files?: Doc<"files">[];
  enabled: boolean;
  settings?: {
    installCommand?: string;
    devCommand?: string;
  };
}

export const useSandbox = ({
  files,
  enabled,
  settings,
}: UseSandboxProps) => {
  const [status, setStatus] = useState<
    "idle" | "booting" | "installing" | "running" | "error"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState("");

  const sandboxIdRef = useRef<string | null>(null);
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

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

        const response = await fetch("/api/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: flatFiles,
            settings,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          throw new Error(
            errorBody?.error || `Failed to create sandbox (${response.status})`
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
                  throw new Error(event.message);
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

        setError(error instanceof Error ? error.message : "Unknown error");
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
      const filesMap = new Map(files.map((f) => [f._id, f]));
      const changedFiles: { path: string; content: string }[] = [];
  
      for (const file of files) {
        if (file.type !== "file" || file.storageId || !file.content) continue;
  
        const filePath = getFilePath(file, filesMap);
        changedFiles.push({ path: filePath, content: file.content });
      }
  
      if (changedFiles.length === 0) return;
  
      // Fire-and-forget file sync
      fetch(`/api/sandbox/${sandboxId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: changedFiles }),
      }).catch(() => {
        // Non-critical — file sync failure shouldn't crash the preview
      });
    }, 1000); // 1-second debounce window

    return () => clearTimeout(timeoutId);
  }, [files, status]);

  // Cleanup sandbox on unmount or when disabled
  useEffect(() => {
    if (!enabled) {
      hasStartedRef.current = false;
      setStatus("idle");
      setPreviewUrl(null);
      setError(null);

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
    setTerminalOutput("");
    setRestartKey((k) => k + 1);
  }, [killSandbox]);

  return {
    status,
    previewUrl,
    error,
    restart,
    terminalOutput,
  };
};
