"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "lucide-react";

import { SIGN_IN_URL } from "@/features/auth/constants";
import { peekPendingPrompt } from "@/features/projects/utils/pending-prompt";
import { peekPendingTemplate } from "@/features/templates/utils/pending-template";

/** Longest prompt shown in full; the rest is in the tooltip. */
export const PROMPT_PREVIEW_LENGTH = 140;

/** Cuts by code points, not UTF-16 units, so an emoji is never split in half. */
export const previewPrompt = (prompt: string) => {
  const chars = Array.from(prompt);
  return chars.length > PROMPT_PREVIEW_LENGTH
    ? `${chars.slice(0, PROMPT_PREVIEW_LENGTH).join("").trimEnd()}…`
    : prompt;
};

// Nothing on the auth pages changes the pending prompt, so there is nothing to subscribe to.
const subscribe = () => () => {};

/**
 * What starts once the visitor is signed in (#252): the prompt or template
 * they picked while signed out. Storage is only readable in the browser, so
 * the server renders nothing. React renders the prompt as text, never HTML.
 */
export const PendingStartNote = () => {
  const prompt = useSyncExternalStore(subscribe, peekPendingPrompt, () => null);
  const template = useSyncExternalStore(subscribe, peekPendingTemplate, () => null);
  const after = usePathname().startsWith(SIGN_IN_URL) ? "right after you log in" : "right after sign-up";
  if (!prompt && !template) return null;

  return (
    <div
      role="status"
      className="w-full max-w-[25rem] rounded-md border border-border bg-card px-4 py-3 text-sm shadow-sm"
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <SparklesIcon aria-hidden className="size-3.5 text-brand" />
        {prompt ? `Your prompt will start building ${after}:` : `Your template opens ${after}:`}
      </p>
      <p title={prompt ?? undefined} className="mt-1 text-muted-foreground break-words">
        {prompt ? previewPrompt(prompt) : template!.title}
      </p>
    </div>
  );
};
