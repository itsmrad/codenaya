"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { SETUP_QUESTIONS, type SetupAnswers } from "../setup-questions";

/** The picked answers; null for Skip; undefined when dismissed without a choice (don't build). */
type SetupOutcome = SetupAnswers | null | undefined;

const useSetupQuestions = create<{
  resolve: ((outcome: SetupOutcome) => void) | null;
  /** The page the ask was made on. */
  askedOn: string | null;
}>()(() => ({ resolve: null, askedOn: null }));

const finish = (answers: SetupOutcome) => {
  const { resolve } = useSetupQuestions.getState();
  useSetupQuestions.setState({ resolve: null, askedOn: null });
  resolve?.(answers);
};

/**
 * Opens the setup questions (#344). Resolves with the picked answers, or null
 * on Skip, Esc or close, which build with the prompt unchanged. Undefined
 * when a newer ask or a navigation replaced it: that caller must not build.
 */
export const askSetupQuestions = () =>
  new Promise<SetupOutcome>((resolve) => {
    finish(undefined);
    useSetupQuestions.setState({ resolve, askedOn: window.location.pathname });
  });

const SetupQuestionsForm = () => {
  const [answers, setAnswers] = useState<SetupAnswers>({});
  return (
    <>
      {SETUP_QUESTIONS.map(({ id, label, options }) => (
        <div key={id} className="min-w-0 space-y-2">
          <p id={`setup-question-${id}`} className="text-sm font-medium">
            {label}
          </p>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            aria-labelledby={`setup-question-${id}`}
            value={answers[id] ?? ""}
            onValueChange={(value) => setAnswers((current) => ({ ...current, [id]: value }))}
            className="w-full flex-wrap justify-start"
          >
            {options.map((option) => (
              <ToggleGroupItem key={option} value={option} className="h-8 flex-none rounded-full px-3 text-xs">
                {option}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ))}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={() => finish(null)}>
          Skip, just build
        </Button>
        <Button type="button" onClick={() => finish(answers)}>
          Build with these answers
        </Button>
      </DialogFooter>
    </>
  );
};

/** Mounted once in the root layout; `askSetupQuestions` opens it. */
export const SetupQuestionsDialog = () => {
  const open = useSetupQuestions((state) => state.resolve !== null);
  // Leaving the page drops a pending ask rather than building from it.
  const pathname = usePathname();
  useEffect(() => {
    const { askedOn } = useSetupQuestions.getState();
    if (askedOn !== null && askedOn !== pathname) finish(undefined);
  }, [pathname]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && finish(null)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>A few quick choices</DialogTitle>
          <DialogDescription>
            Pick what fits before the first build, or skip and the agent uses sensible defaults.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per open, so each ask starts with nothing picked. */}
        {open && <SetupQuestionsForm />}
      </DialogContent>
    </Dialog>
  );
};
