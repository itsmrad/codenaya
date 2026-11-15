"use client";

import { useState } from "react";
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

const useSetupQuestions = create<{ resolve: ((answers: SetupAnswers | null) => void) | null }>()(() => ({
  resolve: null,
}));

const finish = (answers: SetupAnswers | null) => {
  const { resolve } = useSetupQuestions.getState();
  useSetupQuestions.setState({ resolve: null });
  resolve?.(answers);
};

/**
 * Opens the setup questions (#344). Resolves with the picked answers, or null
 * on Skip, Esc or close, which build with the prompt unchanged.
 */
export const askSetupQuestions = () =>
  new Promise<SetupAnswers | null>((resolve) => {
    finish(null);
    useSetupQuestions.setState({ resolve });
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
