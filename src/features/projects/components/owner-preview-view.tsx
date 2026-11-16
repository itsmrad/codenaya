"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

export function OwnerPreviewView({ projectId, initial }: {
  projectId: string;
  initial: { name: string; previewUrl: string | null };
}) {
  const [project, setProject] = useState(initial);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/preview`, { cache: "no-store", signal: controller.signal });
        if (response.status === 404) { setMissing(true); return; }
        if (response.ok) setProject(await response.json());
      } catch {
        // Keep the last preview during a temporary connection failure.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 10_000);
      }
    };
    timer = setTimeout(refresh, 10_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId]);
  if (missing) notFound();
  const editorUrl = `/projects/${projectId}`;
  return (
    <main className="h-dvh flex flex-col bg-background text-foreground">
      <header className="h-12 shrink-0 flex items-center gap-4 border-b border-border px-4">
        <h1 className="min-w-0 truncate text-sm font-medium">{project.name}</h1>
        <Link href={editorUrl} className="ml-auto shrink-0 text-sm underline underline-offset-4">Back to editor</Link>
      </header>
      {project.previewUrl ? (
        <iframe
          src={project.previewUrl}
          title="Preview"
          className="w-full flex-1 min-h-0 border-0 bg-background"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          allow="cross-origin-isolated"
        />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">Start the preview from the editor</p>
          <Link href={editorUrl} className="text-sm underline underline-offset-4">Back to editor</Link>
        </div>
      )}
    </main>
  );
}
