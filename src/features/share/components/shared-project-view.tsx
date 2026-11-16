"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRemix } from "@/features/showcase/hooks/use-remix";
import { sharePath } from "../utils";
import { api } from "../../../../convex/_generated/api";

export type SharedProject = { name: string };
type Status = { status: string; url?: string };

export const SharedProjectView = ({ token, initial }: { token: string; initial: SharedProject }) => {
  const live = useQuery(api.projects.getShared, { token });
  const project = live === undefined ? initial : live;
  const [site, setSite] = useState<Status>({ status: "wait" });
  const [attempt, setAttempt] = useState(0);
  const remixShared = useMutation(api.projects.remixShared);
  const { remix, isRemixing } = useRemix(sharePath(token), useCallback(() => remixShared({ token }), [remixShared, token]));

  useEffect(() => {
    if (live === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (start: boolean) => {
      try {
        const response = await fetch(`/api/public-preview/${token}`, { method: start ? "POST" : "GET", signal: controller.signal, cache: "no-store" });
        const result: Status = response.status === 429 ? { status: "busy" } : await response.json();
        if (controller.signal.aborted) return;
        setSite(result);
        if (["ready", "wait", "boot"].includes(result.status)) {
          timer = setTimeout(() => void poll(result.status === "boot"), result.status === "ready" ? 30_000 : 2500);
        }
      } catch {
        if (!controller.signal.aborted) setSite({ status: "error" });
      }
    };
    void poll(true);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [token, attempt, live === null]);

  const unavailable = !project || site.status === "missing";
  return (
    <main className="h-dvh flex flex-col bg-background text-foreground">
      <header className="shrink-0 flex items-center gap-3 h-11 px-3 sm:px-4 border-b border-border">
        <Link href="/" className="text-xs shrink-0">Made with <span className="font-semibold">Codenaya</span></Link>
        <span className="text-xs text-muted-foreground truncate">{project?.name}</span>
        {!unavailable && <Button size="sm" className="ml-auto h-7 shrink-0 text-xs" onClick={remix} disabled={isRemixing}>{isRemixing ? "Remixing…" : "Remix"}</Button>}
      </header>
      {!unavailable && site.status === "ready" && site.url ? (
        <iframe title={project?.name ?? "Site preview"} src={site.url} className="min-h-0 flex-1 w-full border-0" allow="fullscreen" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" />
      ) : (
        <div role="status" className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          {unavailable ? <p>This share link is unavailable.</p> : site.status === "busy" ? <><p>Busy, try again shortly.</p><Button variant="outline" onClick={() => setAttempt(n => n + 1)}>Try again</Button></> : site.status === "error" ? <><p>We couldn’t start this site.</p><Button variant="outline" onClick={() => setAttempt(n => n + 1)}>Try again</Button></> : <><Spinner className="size-5 text-muted-foreground" /><p className="text-sm">Starting the site… ~30-60 s on first visit</p></>}
        </div>
      )}
    </main>
  );
};
