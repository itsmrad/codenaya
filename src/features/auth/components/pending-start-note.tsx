"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "lucide-react";

import { peekPendingPrompt } from "@/features/projects/utils/pending-prompt";
import { peekPendingTemplate } from "@/features/templates/utils/pending-template";

/** Longest prompt shown in full; the rest is in the tooltip. */
export const PROMPT_PREVIEW_LENGTH = 140;

const subscribe = () => () => {};

/**
 * What starts once the visitor is signed in (#252): the prompt or template
 * they picked while signed out. Storage is only readable in the browser, so
 * the server renders nothing. React renders the prompt as text, never HTML.
 */
export const PendingStartNote = () => {
  const prompt = useSyncExternalStore(subscribe, peekPendingPrompt, () => null);
  const template = useSyncExternalStore(subscribe, peekPendingTemplate, () => null);
  const after = usePathname().startsWith("/sign-in") ? "right after you log in" : "right after sign-up";
  if (!prompt && !template) return null;

  const shown =
    prompt && prompt.length > PROMPT_PREVIEW_LENGTH
      ? `${prompt.slice(0, PROMPT_PREVIEW_LENGTH).trimEnd()}…`
      : prompt;

  return (
    <div
      role="status"
      className="w-full max-w-[25rem] rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <SparklesIcon aria-hidden className="size-3.5 text-brand" />
        {prompt ? `Your prompt will start building ${after}:` : `Your template opens ${after}:`}
      </p>
      <p title={prompt ?? undefined} className="mt-1 text-muted-foreground break-words">
        {prompt ? shown : template!.title}
      </p>
    </div>
  );
};
