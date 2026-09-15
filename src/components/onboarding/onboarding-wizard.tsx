"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";

// Convex lives at the repo root, outside src/ — this relative path matches
// the pattern already used elsewhere in the codebase (see
// src/app/api/projects/create-with-prompt/route.ts).
import { api } from "../../../convex/_generated/api";

import { TerminalPanel } from "./terminal-panel";
import { StepHeader } from "./step-header";
import { WelcomeStep } from "./steps/welcome-step";
import { FeaturesStep } from "./steps/features-step";
import { AuthStep } from "./steps/auth-step";
import { GithubStep } from "./steps/github-step";
import { ModelStep } from "./steps/model-step";
import { ProjectStep } from "./steps/project-step";
import { getActiveFlow, type AuthMethod, type ModelId, type StepKey } from "./types";
import { completeOnboarding } from "@/app/onboarding/actions";

export function OnboardingWizard() {
  const router = useRouter();
  const createProject = useMutation(api.projects.create);

  const [stepKey, setStepKey] = useState<StepKey>("welcome");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [model, setModel] = useState<ModelId>("claude-sonnet-4");
  const [projectName, setProjectName] = useState("my-first-app");
  const [template, setTemplate] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);

  const flow = getActiveFlow(authMethod);
  const index = flow.indexOf(stepKey);

  function goNext() {
    if (index < flow.length - 1) setStepKey(flow[index + 1]);
  }
  function goBack() {
    if (index > 0) setStepKey(flow[index - 1]);
  }

  function handleAuthed(method: AuthMethod) {
    setAuthMethod(method);
    // Signing in with GitHub also grants repo access, so mark it connected —
    // getActiveFlow() will drop the redundant "github" step automatically.
    if (method === "github") setGithubConnected(true);
    goNext();
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const projectId = await createProject({ name: projectName.trim() });
      await completeOnboarding(model);
      setCreatedProjectId(projectId);
      setCreated(true);
    } catch (err) {
      console.error("Failed to create project", err);
      // TODO: surface this to the user instead of just logging — e.g. a
      // toast via the existing sonner setup in components/ui/sonner.tsx.
    } finally {
      setCreating(false);
    }
  }

  function handleGoToDashboard() {
    if (createdProjectId) {
      router.push(`/projects/${createdProjectId}`);
    } else {
      router.push("/");
    }
  }

  return (
    // Forced dark — this design isn't meant to adapt to light mode.
    <div className="dark flex min-h-screen bg-card">
      <TerminalPanel
        stepKey={stepKey}
        authMethod={authMethod}
        githubConnected={githubConnected}
        model={model}
        projectName={projectName}
        created={created}
      />

      <div className="flex flex-1 flex-col px-8 pt-14 md:px-18 md:pt-20">
        <StepHeader flow={flow} stepKey={stepKey} />

        <div className="flex-1">
          {stepKey === "welcome" && <WelcomeStep onNext={goNext} />}

          {stepKey === "features" && (
            <FeaturesStep onNext={goNext} onBack={goBack} />
          )}

          {stepKey === "auth" && (
            <AuthStep onAuthed={handleAuthed} onBack={goBack} />
          )}

          {stepKey === "github" && (
            <GithubStep
              connected={githubConnected}
              onToggle={() => setGithubConnected((v) => !v)}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {stepKey === "model" && (
            <ModelStep
              model={model}
              onSelect={setModel}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {stepKey === "project" && (
            <ProjectStep
              projectName={projectName}
              onProjectNameChange={setProjectName}
              template={template}
              onTemplateChange={setTemplate}
              onBack={goBack}
              onCreate={handleCreate}
              creating={creating}
              created={created}
              model={model}
              githubConnected={githubConnected}
              onGoToDashboard={handleGoToDashboard}
            />
          )}
        </div>
      </div>
    </div>
  );
}
