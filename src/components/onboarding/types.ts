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
}

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
 * The "github" step is skipped entirely if the person authenticated via
 * GitHub in the auth step — they've already granted repo access, so
 * asking again would be redundant.
 */
export function getActiveFlow(authMethod: AuthMethod): StepKey[] {
  return ALL_STEPS.filter((s) => !(s === "github" && authMethod === "github"));
}
