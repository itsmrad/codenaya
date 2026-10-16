export type StepKey =
  | "welcome"
  | "features"
  | "auth"
  | "github"
  | "model"
  | "project";

export type AuthMethod = "github" | "email" | null;

export type ModelId = "claude-sonnet-4" | "gemini-2.0-flash";

export interface OnboardingState {
  stepKey: StepKey;
  authMethod: AuthMethod;
  githubConnected: boolean;
  model: ModelId;
  projectName: string;
  template: number;
  prompt?: string;
  projectId?: string | null;
  created?: boolean;
}

export const ONBOARDING_STORAGE_KEY = "codenaya_onboarding_state";
export const ONBOARDING_PROMPT_KEY = "codenaya_initial_prompt";

export const ALL_STEPS: StepKey[] = [
  "welcome",
  "features",
  "auth",
  "github",
  "model",
  "project",
];

export const STEP_TITLES: Record<StepKey, string> = {
  welcome: "Welcome",
  features: "What you get",
  auth: "Log in or sign up",
  github: "Connect a repository",
  model: "Choose your AI model",
  project: "Create your project",
};

/**
 * The "auth" step is skipped when the user is already signed in (e.g. they
 * signed up via landing page modal or authenticated in a previous step).
 *
 * The "github" step is retained in the flow so the user can connect, review,
 * or disconnect their GitHub repository access.
 */
export function getActiveFlow(
  authMethod?: AuthMethod,
  isAuthed = false,
  hasGithub = false
): StepKey[] {
  void authMethod;
  void hasGithub;
  return ALL_STEPS.filter((s) => {
    if (s === "auth" && isAuthed) return false;
    return true;
  });
}

/**
 * Finds the next valid step in activeFlow when current step is no longer
 * part of the flow (e.g. auth step was completed). Prevents accidentally
 * resetting progress back to the first step.
 */
export function getNextValidStep(current: StepKey, activeFlow: StepKey[]): StepKey {
  if (activeFlow.includes(current)) return current;
  const currentIndex = ALL_STEPS.indexOf(current);
  for (let i = currentIndex + 1; i < ALL_STEPS.length; i++) {
    if (activeFlow.includes(ALL_STEPS[i])) {
      return ALL_STEPS[i];
    }
  }
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (activeFlow.includes(ALL_STEPS[i])) {
      return ALL_STEPS[i];
    }
  }
  return activeFlow[0] ?? "welcome";
}
