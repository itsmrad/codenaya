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

import type { SetupAnswers, SetupQuestion } from "../setup-questions";

/** The picked answers; null for Skip; undefined when dismissed without a choice (don't build). */
type SetupOutcome = SetupAnswers | null | undefined;

const useSetupQuestions = create<{
  resolve: ((outcome: SetupOutcome) => void) | null;
  /** The page the ask was made on. */
  askedOn: string | null;
  questions: readonly SetupQuestion[];
}>()(() => ({ resolve: null, askedOn: null, questions: [] }));

const finish = (answers: SetupOutcome) => {
  const { resolve } = useSetupQuestions.getState();
  useSetupQuestions.setState({ resolve: null, askedOn: null });
  resolve?.(answers);
};

/**
 * Opens the given setup questions (#344). Resolves with the picked answers, or null
 * on Skip, Esc or close, which build with the prompt unchanged. Undefined
 * when a newer ask or a navigation replaced it: that caller must not build.
 */
export const askSetupQuestions = (questions: readonly SetupQuestion[]) =>
  new Promise<SetupOutcome>((resolve) => {
    finish(undefined);
    useSetupQuestions.setState({ resolve, askedOn: window.location.pathname, questions });
  });

const SetupQuestionsForm = ({ questions }: { questions: readonly SetupQuestion[] }) => {
  // The recommended options start picked, so one click builds with them.
  const [answers, setAnswers] = useState<SetupAnswers>(() =>
    Object.fromEntries(questions.flatMap(({ id, recommended }) => (recommended ? [[id, recommended]] : []))),
  );
  return (
    <>
      {questions.map(({ id, label, options, recommended }) => (
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
                {option === recommended && <span className="text-muted-foreground">(recommended)</span>}
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
  const questions = useSetupQuestions((state) => state.questions);
  // Leaving the page drops a pending ask rather than building from it.
  const pathname = usePathname();
  useEffect(() => {
    const { askedOn } = useSetupQuestions.getState();
    if (askedOn !== null && askedOn !== pathname) finish(undefined);
  }, [pathname]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && finish(null)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>A few quick choices</DialogTitle>
          <DialogDescription>
            Pick what fits before the first build, or skip and the agent uses sensible defaults.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per open, so each ask starts with nothing picked. */}
        {open && <SetupQuestionsForm questions={questions} />}
      </DialogContent>
    </Dialog>
  );
};
