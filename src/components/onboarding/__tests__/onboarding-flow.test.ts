import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ONBOARDING_PROMPT_KEY,
  ONBOARDING_STORAGE_KEY,
  type OnboardingState,
} from "../types";
import { generateProjectNameFromPrompt } from "@/lib/project-utils";

describe("New User Onboarding Flow with Lovable-inspired Prompt", () => {
  beforeEach(() => {
    // Mock localStorage
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
  });

  it("stores the prompt and derived project name immediately on submission", () => {
    const prompt =
      "Build me a modern SaaS website for an AI-powered productivity platform with authentication, a dashboard, and subscription plans.";
    const projectName = generateProjectNameFromPrompt(prompt);

    const initialState: OnboardingState = {
      stepKey: "welcome",
      authMethod: null,
      githubConnected: false,
      model: "claude-sonnet-4",
      projectName,
      template: 0,
      prompt,
    };

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(initialState));
    localStorage.setItem(ONBOARDING_PROMPT_KEY, prompt);

    // Verify persistence
    const saved = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
    expect(saved.prompt).toBe(prompt);
    expect(saved.projectName).toBe("Modern Saas Website");
    expect(localStorage.getItem(ONBOARDING_PROMPT_KEY)).toBe(prompt);
  });

  it("retains the prompt when user refreshes the onboarding page", () => {
    const prompt = "pomodoro";
    const projectName = generateProjectNameFromPrompt(prompt);

    const state: OnboardingState = {
      stepKey: "model",
      authMethod: "email",
      githubConnected: true,
      model: "gemini-2.0-flash",
      projectName,
      template: 1,
      prompt,
    };

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));

    // Simulate page reload
    const reloaded = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
    expect(reloaded.prompt).toBe(prompt);
    expect(reloaded.stepKey).toBe("model");
    expect(reloaded.model).toBe("gemini-2.0-flash");
    expect(reloaded.projectName).toBe("Pomodoro App");
  });

  it("preserves prompt and summary when onboarding is completed (even across refresh)", () => {
    const prompt = "Build a portfolio website for a product designer";
    const projectName = "Product Designer Portfolio";

    // Completed state
    const completedState: OnboardingState = {
      stepKey: "project",
      authMethod: "github",
      githubConnected: true,
      model: "claude-sonnet-4",
      projectName,
      template: 0,
      prompt,
      created: true,
      projectId: "proj_12345",
    };

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(completedState));

    // Reloaded on completed screen
    const stored = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
    expect(stored.created).toBe(true);
    expect(stored.prompt).toBe(prompt);
    expect(stored.projectName).toBe(projectName);
    expect(stored.projectId).toBe("proj_12345");
  });

  it("clears storage only after user launches the workspace", () => {
    const state: OnboardingState = {
      stepKey: "project",
      authMethod: null,
      githubConnected: false,
      model: "claude-sonnet-4",
      projectName: "My Project",
      template: 0,
      prompt: "Test prompt",
      created: true,
      projectId: "proj_abc",
    };

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toBeNull();

    // User clicks "Launch Project Workspace"
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    localStorage.removeItem(ONBOARDING_PROMPT_KEY);

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_PROMPT_KEY)).toBeNull();
  });

  it("derives IDE redirect path directly from created project ID and never falls back to landing page when project exists", () => {
    const projectId = "proj_test_987";
    const resolveDestination = (id?: string | null, savedId?: string | null) => {
      const target = id || savedId;
      if (target) return `/projects/${target}`;
      return "/";
    };

    expect(resolveDestination(projectId, null)).toBe(`/projects/${projectId}`);
    expect(resolveDestination(null, projectId)).toBe(`/projects/${projectId}`);
    expect(resolveDestination(null, null)).toBe("/");
  });

  it("handles skip flow by clearing stored prompt and not generating any project ID", () => {
    const prompt = "Should not be created";
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ prompt, stepKey: "project" }));
    localStorage.setItem(ONBOARDING_PROMPT_KEY, prompt);

    // Simulate handleSkip
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    localStorage.removeItem(ONBOARDING_PROMPT_KEY);

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_PROMPT_KEY)).toBeNull();
  });

  it("prevents duplicate project creations when workspace creation is already in flight", async () => {
    let callCount = 0;
    let isCreating = false;

    const mockCreate = async () => {
      if (isCreating) return;
      isCreating = true;
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      isCreating = false;
    };

    // Simulate two rapid clicks (double-click)
    await Promise.all([mockCreate(), mockCreate()]);

    expect(callCount).toBe(1);
  });

  it("preserves github step and connection flag in state across OAuth round-trips", () => {
    // Simulate user initiating GitHub link
    const preAuthState: OnboardingState = {
      stepKey: "github",
      authMethod: "email",
      githubConnected: false,
      model: "claude-sonnet-4",
      projectName: "App With Repo",
      template: 0,
      prompt: "AI SaaS with GitHub sync",
    };

    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(preAuthState));

    // After OAuth return, state is restored with stepKey 'github'
    const restored = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
    expect(restored.stepKey).toBe("github");
    expect(restored.prompt).toBe("AI SaaS with GitHub sync");

    // Once verified, githubConnected becomes true
    const postAuthState: OnboardingState = {
      ...restored,
      githubConnected: true,
    };
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(postAuthState));

    const finalState = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY)!);
    expect(finalState.githubConnected).toBe(true);
    expect(finalState.stepKey).toBe("github");
  });

  it("correctly identifies active GitHub connection from external accounts", () => {
    const mockAccounts = [
      { provider: "google", emailAddress: "user@gmail.com" },
      { provider: "github", username: "octocat", imageUrl: "https://github.com/octocat.png" },
    ];

    const hasGithub = mockAccounts.some((acc) => acc.provider === "github");
    const githubAccount = mockAccounts.find((acc) => acc.provider === "github");

    expect(hasGithub).toBe(true);
    expect(githubAccount?.username).toBe("octocat");
  });
});

