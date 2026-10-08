"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { CheckCircle2Icon, ChevronRightIcon, CircleIcon, XIcon } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { ACCOUNT_SETTINGS_URL, AI_PROVIDERS_SETTINGS_URL } from "@/features/settings/nav";

import { api } from "../../../../convex/_generated/api";
import { Doc } from "../../../../convex/_generated/dataModel";
import {
  dismissFirstRun,
  getFirstRunProgress,
  hasOpenedPreview,
  isFirstRunDismissed,
  type FirstRunStep,
} from "../utils/first-run";

// The storage flags only change through this tab, so dismissing notifies here.
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

interface FirstRunChecklistProps {
  projects: Doc<"projects">[] | undefined;
  onNewProject: () => void;
}

/**
 * "Get started" card on the dashboard: five steps whose state comes from the
 * user's real data. Hidden once every step is done or the user dismisses it.
 */
export const FirstRunChecklist = ({ projects, onNewProject }: FirstRunChecklistProps) => {
  const { user } = useUser();
  const userId = user?.id;
  // Null on the server and until Clerk loads, so nothing flashes.
  const dismissed = useSyncExternalStore(
    subscribe,
    () => (userId ? isFirstRunDismissed(userId) : null),
    () => null,
  );
  const previewOpened = useSyncExternalStore(subscribe, hasOpenedPreview, () => false);

  const active = dismissed === false;
  const aiKeys = useQuery(api.aiProviders.list, active ? {} : "skip");
  const skills = useQuery(api.skills.listLibrary, active ? {} : "skip");
  const published = useQuery(api.showcase.getMyPublished, active ? {} : "skip");

  if (!active || !user || !projects || !aiKeys || !skills || !published) return null;

  const progress = getFirstRunProgress({
    projects,
    published,
    aiKeyCount: aiKeys.length,
    skillCount: skills.length,
    githubConnected: user.externalAccounts.some((account) => account.provider === "github"),
    previewOpened,
  });
  const doneCount = Object.values(progress).filter(Boolean).length;
  if (doneCount === Object.keys(progress).length) return null;

  const latestProject = projects[0] ? `/projects/${projects[0]._id}` : null;
  const steps: { id: FirstRunStep; label: string; href?: string | null; onClick?: () => void }[] = [
    { id: "createProject", label: "Create your first app", onClick: onNewProject },
    {
      id: "openPreview",
      label: "Open the preview",
      href: latestProject && `${latestProject}?view=preview`,
    },
    { id: "connectGithub", label: "Connect GitHub", href: ACCOUNT_SETTINGS_URL },
    { id: "addKeyOrSkill", label: "Add an AI key or a skill", href: AI_PROVIDERS_SETTINGS_URL },
    { id: "ship", label: "Publish or export to GitHub", href: latestProject },
  ];

  const handleDismiss = () => {
    dismissFirstRun(user.id);
    listeners.forEach((listener) => listener());
  };

  return (
    <section
      aria-labelledby="first-run-heading"
      className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="first-run-heading" className="text-base font-semibold tracking-tight">
            Get started with Codenaya
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <button
          onClick={handleDismiss}
          aria-label="Dismiss getting started checklist"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <Progress
        value={(doneCount / steps.length) * 100}
        aria-label="Getting started progress"
        className="mt-3 h-1.5 bg-muted [&>[data-slot=progress-indicator]]:bg-brand"
      />

      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step) => {
          const done = progress[step.id];
          const actionable = !done && Boolean(step.onClick || step.href);
          const content = (
            <>
              {done ? (
                <CheckCircle2Icon aria-hidden className="size-4 shrink-0 text-brand" />
              ) : (
                <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />
              )}
              <span className={done ? "text-muted-foreground line-through" : "text-foreground"}>
                {step.label}
              </span>
              {actionable && (
                <ChevronRightIcon
                  aria-hidden
                  className="ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
                />
              )}
            </>
          );
          const className =
            "group flex h-full w-full items-center gap-2.5 rounded-xl border border-border/60 px-3 py-2.5 text-left text-xs font-medium transition-colors";
          const interactive = `${className} hover:border-brand/40 hover:bg-brand/[0.03]`;

          return (
            <li key={step.id} data-done={done}>
              {done ? (
                <div className={`${className} bg-muted/30`}>
                  {content}
                  <span className="sr-only">(done)</span>
                </div>
              ) : step.onClick ? (
                <button onClick={step.onClick} className={interactive}>
                  {content}
                </button>
              ) : step.href ? (
                <Link href={step.href} className={interactive}>
                  {content}
                </Link>
              ) : (
                <div className={className}>{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
