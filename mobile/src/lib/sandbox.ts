import { useAuth } from "@clerk/expo";
import { fetch } from "expo/fetch";
import { useEffect, useRef, useState } from "react";

import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { API_URL } from "./env";
import { BOOT_OUT_OF_TIME, type BootPhase, afterBootStream, buildFlatFileList, getChangedFiles, isBootPhase } from "./shared";

export type SandboxStatus = "idle" | "booting" | "installing" | "running" | "error";

const NETWORK_ERROR = "Couldn't reach the preview sandbox. Check your connection and retry.";

/**
 * The web's useSandbox (src/features/sandbox-preview/hooks/use-sandbox.ts) on
 * the phone: once enabled, boots an E2B sandbox through /api/sandbox and reads
 * its NDJSON progress, sends file edits to the running sandbox, and kills it
 * when disabled or unmounted. expo/fetch, because RN's fetch can't stream.
 * ponytail: no terminal output or compile-error banner yet; both come from the
 * stream's "output" events if the app needs them.
 */
export function useSandbox({
  projectId,
  files,
  enabled,
  settings,
}: {
  projectId: Id<"projects">;
  files: Doc<"files">[] | undefined;
  enabled: boolean;
  settings?: { installCommand?: string; devCommand?: string };
}) {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<SandboxStatus>("idle");
  const [phase, setPhase] = useState<BootPhase | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  /** Stopped by the user: the sandbox is killed and stays down until started again. */
  const [stopped, setStopped] = useState(false);
  const sandboxId = useRef<string | null>(null);
  /** Path → content the sandbox already has, so a sync sends only real edits. */
  const synced = useRef(new Map<string, string>());
  const syncing = useRef(Promise.resolve());

  const call = async (path: string, method: string, body?: unknown, signal?: AbortSignal) =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

  const canBoot = enabled && !stopped && Boolean(files?.length);

  // Boots once per enable or restart; edits after that go through the sync below.
  useEffect(() => {
    if (!canBoot || !files) return;
    const abort = new AbortController();
    let ready = false;

    const boot = async () => {
      setStatus("booting");
      setPhase(null);
      setPreviewUrl(null);
      setError(null);
      const flat = buildFlatFileList(files);
      synced.current = new Map(flat.map((file) => [file.path, file.content]));

      // A boot that runs out of server time continues on the same sandbox (#492).
      let resumeSandboxId: string | undefined;
      for (let resumes = 0; ; resumes++) {
        const response = await call("/api/sandbox", "POST", { files: flat, settings, projectId, resumeSandboxId }, abort.signal);
        resumeSandboxId = undefined;
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to create sandbox (${response.status})`);
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.type === "status") setStatus(event.status);
            else if (event.type === "phase" && isBootPhase(event.phase)) setPhase(event.phase);
            else if (event.type === "ready") {
              ready = true;
              sandboxId.current = event.sandboxId;
              setPreviewUrl(event.previewUrl);
              setStatus("running");
            } else if (event.type === "resume") {
              resumeSandboxId = event.sandboxId;
              // So a restart or unmount still kills it between requests.
              sandboxId.current = event.sandboxId;
            } else if (event.type === "error") throw new Error(event.message);
          }
        }
        const next = afterBootStream({ ready, resumeSandboxId, resumes });
        if (next === "done") return;
        if (next === "failed") throw new Error(BOOT_OUT_OF_TIME);
      }
    };

    boot().catch((caught: unknown) => {
      // Aborted by cleanup, or the log stream dropped after ready: the preview still runs.
      if (abort.signal.aborted || ready) return;
      setError(caught instanceof TypeError ? NETWORK_ERROR : caught instanceof Error ? caught.message : "Unknown error");
      setStatus("error");
    });

    return () => {
      abort.abort();
      const id = sandboxId.current;
      sandboxId.current = null;
      setStatus("idle");
      if (id) call(`/api/sandbox/${id}`, "DELETE").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- files and settings are read at boot only
  }, [canBoot, restartKey]);

  // Edits reach the running sandbox, batched and in order, as on the web.
  useEffect(() => {
    const id = sandboxId.current;
    if (!id || !files || status !== "running") return;
    const timer = setTimeout(() => {
      const changed = getChangedFiles(buildFlatFileList(files), synced.current);
      if (changed.length === 0) return;
      for (const file of changed) synced.current.set(file.path, file.content);
      syncing.current = syncing.current
        .then(() => call(`/api/sandbox/${id}`, "PATCH", { files: changed, installCommand: settings?.installCommand }))
        .then(
          () => undefined,
          () => undefined,
        );
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` only reads the latest token
  }, [files, status, settings?.installCommand]);

  return {
    status,
    phase,
    previewUrl,
    error,
    stopped,
    stop: () => setStopped(true),
    start: () => setStopped(false),
    restart: () => {
      setStopped(false);
      setRestartKey((key) => key + 1);
    },
  };
}
