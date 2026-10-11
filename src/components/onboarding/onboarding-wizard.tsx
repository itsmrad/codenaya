"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { useAuth, useUser, useReverification } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

import { api } from "../../../convex/_generated/api";

import { TerminalPanel } from "./terminal-panel";
import { StepHeader } from "./step-header";
import { WelcomeStep } from "./steps/welcome-step";
import { FeaturesStep } from "./steps/features-step";
import { AuthStep } from "./steps/auth-step";
import { GithubStep } from "./steps/github-step";
import { ModelStep } from "./steps/model-step";
import { ProjectStep } from "./steps/project-step";
import {
  ALL_STEPS,
  getActiveFlow,
  getNextValidStep,
  ONBOARDING_PROMPT_KEY,
  ONBOARDING_STORAGE_KEY,
  type AuthMethod,
  type ModelId,
  type OnboardingState,
  type StepKey,
} from "./types";
import { completeOnboarding, skipOnboarding } from "@/app/onboarding/actions";

export function OnboardingWizard() {
  const createProject = useMutation(api.projects.create);
  const { isSignedIn } = useAuth();
  const { user } = useUser();

  const isAuthed = !!isSignedIn;
  const githubAccount = user?.externalAccounts?.find(
    (acc) => acc.provider === "github"
  );
  const hasGithub = !!githubAccount;
  const githubUsername =
    githubAccount?.username ||
    (typeof (githubAccount as unknown as { accountIdentifier?: () => string })?.accountIdentifier === "function"
      ? (githubAccount as unknown as { accountIdentifier: () => string }).accountIdentifier()
      : null) ||
    (githubAccount as unknown as { externalAccount?: { username?: string } })?.externalAccount?.username ||
    githubAccount?.emailAddress ||
    (hasGithub ? user?.username : null) ||
    null;
  const githubAvatarUrl =
    githubAccount?.imageUrl || (hasGithub ? user?.imageUrl : null) || null;

  const [stepKey, setStepKey] = useState<StepKey>("welcome");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);
  const [model, setModel] = useState<ModelId>("claude-sonnet-4");
  const [projectName, setProjectName] = useState("my-first-app");
  const [template, setTemplate] = useState(0);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [created, setCreated] = useState(false);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const isCreatingRef = useRef(false);
  const isHydratedRef = useRef(false);

  const isGithubConnected = githubConnected || hasGithub;
  const flow = getActiveFlow(authMethod, isAuthed, isGithubConnected);
  const index = flow.indexOf(stepKey);

  // Clerk reverification wrapper for sensitive external account actions
  const createExternalAccountWithReverification = useReverification(
    async (params: Parameters<NonNullable<typeof user>["createExternalAccount"]>[0]) => {
      if (!user) throw new Error("Please sign in first to connect your GitHub account.");
      return await user.createExternalAccount(params);
    }
  );

  const destroyExternalAccountWithReverification = useReverification(
    async (account: { destroy: () => Promise<void> }) => {
      return await account.destroy();
    }
  );

  // Restore onboarding progress and prompt from localStorage on mount
  useEffect(() => {
    try {
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const isLinkedCallback = params?.get("linked") === "github";

      const saved = localStorage.getItem(ONBOARDING_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as OnboardingState;
        if (parsed.stepKey && ALL_STEPS.includes(parsed.stepKey)) {
          const targetStep = isLinkedCallback ? "github" : parsed.stepKey;
          setStepKey(targetStep);
        } else if (isLinkedCallback) {
          setStepKey("github");
        }
        if (parsed.authMethod) setAuthMethod(parsed.authMethod);
        if (typeof parsed.githubConnected === "boolean") {
          setGithubConnected(parsed.githubConnected);
        }
        if (parsed.model) setModel(parsed.model);
        if (parsed.projectName) setProjectName(parsed.projectName);
        if (typeof parsed.template === "number") setTemplate(parsed.template);
        if (parsed.prompt) setPrompt(parsed.prompt);
        if (parsed.projectId) setCreatedProjectId(parsed.projectId);
        if (parsed.created) setCreated(true);
      } else if (isLinkedCallback) {
        setStepKey("github");
      }

      // Check fallback dedicated prompt key if not found in state
      if (!saved || !JSON.parse(saved).prompt) {
        const savedPrompt = localStorage.getItem(ONBOARDING_PROMPT_KEY);
        if (savedPrompt) {
          setPrompt(savedPrompt);
        }
      }
    } catch {
      // Ignore localStorage read errors
    } finally {
      isHydratedRef.current = true;
    }
  }, []);

  // Persist onboarding progress whenever state changes (only after hydration)
  useEffect(() => {
    if (!isHydratedRef.current) return;
    try {
      const stateToSave: OnboardingState = {
        stepKey,
        authMethod,
        githubConnected: isGithubConnected,
        model,
        projectName,
        template,
        prompt: prompt || undefined,
        projectId: createdProjectId,
        created,
      };
      localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify(stateToSave)
      );
      if (prompt) {
        localStorage.setItem(ONBOARDING_PROMPT_KEY, prompt);
      }
    } catch {
      // Ignore localStorage write errors
    }
  }, [
    stepKey,
    authMethod,
    isGithubConnected,
    model,
    projectName,
    template,
    prompt,
    created,
    createdProjectId,
  ]);

  // Adjust stepKey if current stepKey is no longer in the active flow (e.g. auth was completed)
  useEffect(() => {
    if (!flow.includes(stepKey)) {
      setStepKey(getNextValidStep(stepKey, flow));
    }
  }, [flow, stepKey]);

  // Automatically update githubConnected if Clerk indicates an active external GitHub account
  useEffect(() => {
    if (hasGithub) {
      setGithubConnected(true);
    }
  }, [hasGithub]);

  // Handle returning from GitHub OAuth redirect flow (?linked=github or session flag)
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;

    const params = new URLSearchParams(window.location.search);
    const isLinkedCallback = params.get("linked") === "github";
    const isLinkingSession = sessionStorage.getItem("codenaya_linking_github") === "true";

    if (isLinkedCallback || isLinkingSession) {
      setGithubLoading(true);

      // Clean URL params if present
      if (isLinkedCallback) {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, "", cleanUrl);
      }
      sessionStorage.removeItem("codenaya_linking_github");

      // Stay pinned on the github step
      setStepKey("github");

      // Reload user from Clerk backend to pick up newly added external account
      const verifyConnection = async (attempt = 0) => {
        try {
          await user.reload();
          const linkedAccount = user.externalAccounts?.find(
            (acc) => acc.provider === "github"
          );
          if (linkedAccount) {
            setGithubConnected(true);
            toast.success("GitHub account linked successfully!");
            setGithubLoading(false);
          } else if (attempt < 2) {
            setTimeout(() => void verifyConnection(attempt + 1), 600);
          } else {
            const clerkStatus = params.get("__clerk_status");
            if (clerkStatus === "error") {
              toast.error("GitHub authorization was cancelled or failed.");
            }
            setGithubLoading(false);
          }
        } catch {
          setGithubLoading(false);
        }
      };

      void verifyConnection();
    }
  }, [user]);

  function goNext() {
    if (index < flow.length - 1) setStepKey(flow[index + 1]);
  }
  function goBack() {
    if (index > 0) setStepKey(flow[index - 1]);
  }

  function handleAuthed(method: AuthMethod) {
    setAuthMethod(method);
    if (method === "github") setGithubConnected(true);
    goNext();
  }

  async function handleLinkGithub() {
    if (!user) {
      toast.error("Please sign in first to connect your GitHub account.");
      return;
    }

    if (hasGithub) {
      setGithubConnected(true);
      toast.info("GitHub account is already connected!");
      return;
    }

    setGithubLoading(true);
    try {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("codenaya_linking_github", "true");
        // Ensure localStorage is pinned to github step before redirect
        try {
          const currentState: OnboardingState = {
            stepKey: "github",
            authMethod,
            githubConnected: false,
            model,
            projectName,
            template,
            prompt: prompt || undefined,
            projectId: createdProjectId,
            created,
          };
          localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(currentState));
        } catch {}
      }

      const redirectUrl = `${window.location.origin}/onboarding?linked=github`;
      const res = await createExternalAccountWithReverification({
        strategy: "oauth_github",
        redirectUrl,
        additionalScopes: ["repo", "read:user"],
      });

      const targetUrl =
        res?.verification?.externalVerificationRedirectURL?.href ||
        (typeof res?.verification?.externalVerificationRedirectURL === "string"
          ? res.verification.externalVerificationRedirectURL
          : res?.verification?.externalVerificationRedirectURL?.toString());

      if (targetUrl) {
        window.location.href = targetUrl;
      } else {
        await user.reload();
        setGithubConnected(true);
        toast.success("GitHub account linked successfully!");
        setGithubLoading(false);
      }
    } catch (err: unknown) {
      console.error("Failed to link GitHub account:", err);

      if (
        isReverificationCancelledError(err) ||
        (err as { code?: string })?.code === "reverification_cancelled" ||
        (err as Error)?.message?.toLowerCase().includes("cancel")
      ) {
        if (typeof window !== "undefined") {
          sessionStorage.removeItem("codenaya_linking_github");
        }
        setGithubLoading(false);
        return;
      }

      if (typeof window !== "undefined") {
        sessionStorage.removeItem("codenaya_linking_github");
      }

      const message =
        err && typeof err === "object" && "errors" in err && Array.isArray((err as { errors: unknown[] }).errors)
          ? (err as { errors: { longMessage?: string; message?: string }[] }).errors[0]?.longMessage ||
            (err as { errors: { longMessage?: string; message?: string }[] }).errors[0]?.message
          : err instanceof Error
          ? err.message
          : "Failed to link GitHub account";
      toast.error(message);
      setGithubLoading(false);
    }
  }

  async function handleUnlinkGithub() {
    if (!user) return;
    const githubAcc = user.externalAccounts?.find(
      (acc) => acc.provider === "github"
    );
    if (!githubAcc) {
      setGithubConnected(false);
      return;
    }

    setGithubLoading(true);
    try {
      await destroyExternalAccountWithReverification(githubAcc);
      await user.reload();
      setGithubConnected(false);
      toast.success("GitHub account unlinked.");
    } catch (err: unknown) {
      console.error("Failed to unlink GitHub account:", err);

      if (
        isReverificationCancelledError(err) ||
        (err as { code?: string })?.code === "reverification_cancelled" ||
        (err as Error)?.message?.toLowerCase().includes("cancel")
      ) {
        setGithubLoading(false);
        return;
      }

      const message =
        err && typeof err === "object" && "errors" in err && Array.isArray((err as { errors: unknown[] }).errors)
          ? (err as { errors: { longMessage?: string; message?: string }[] }).errors[0]?.longMessage ||
            (err as { errors: { longMessage?: string; message?: string }[] }).errors[0]?.message
          : err instanceof Error
          ? err.message
          : "Failed to unlink GitHub account";
      toast.error(message);
    } finally {
      setGithubLoading(false);
    }
  }

  async function handleSkip() {
    if (skipping || creating || isCreatingRef.current) return;
    setSkipping(true);

    try {
      // Clear any pending draft state from localStorage
      try {
        localStorage.removeItem(ONBOARDING_STORAGE_KEY);
        localStorage.removeItem(ONBOARDING_PROMPT_KEY);
      } catch {}

      // Mark onboarding as completed/skipped in Clerk user metadata
      await skipOnboarding(model);
      await user?.reload().catch(() => {});

      toast.success("Welcome to Codenaya!");

      // Navigate to the user dashboard
      window.location.href = "/";
    } catch (err) {
      console.error("Failed to skip onboarding", err);
      window.location.href = "/";
    } finally {
      setSkipping(false);
    }
  }

  async function handleCreate() {
    if (isCreatingRef.current || creating || created) {
      if (createdProjectId) {
        handleGoToDashboard(createdProjectId);
      }
      return;
    }
    isCreatingRef.current = true;
    setCreating(true);

    try {
      let finalProjectId = createdProjectId;

      if (!finalProjectId) {
        try {
          // Direct Convex mutation: creates project, conversation, and prompt message atomically
          finalProjectId = await createProject({
            name: projectName.trim(),
            initialPrompt: prompt || undefined,
          });
        } catch (directErr) {
          console.warn("Direct Convex mutation failed, trying fallback API route", directErr);
          // Fallback to internal API route using Clerk server auth + CODENAYA_CONVEX_INTERNAL_KEY
          const res = await fetch("/api/projects/create-with-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectName: projectName.trim(),
              prompt: prompt || "Initialize workspace",
            }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Server returned ${res.status}`);
          }
          const data = await res.json();
          finalProjectId = data.projectId;
        }
      }

      if (!finalProjectId) {
        throw new Error("Project ID was not returned.");
      }

      setCreatedProjectId(finalProjectId);
      setCreated(true);

      // Save state to localStorage immediately with createdProjectId
      try {
        const stateToSave: OnboardingState = {
          stepKey,
          authMethod,
          githubConnected: isGithubConnected,
          model,
          projectName,
          template,
          prompt: prompt || undefined,
          projectId: finalProjectId,
          created: true,
        };
        localStorage.setItem(
          ONBOARDING_STORAGE_KEY,
          JSON.stringify(stateToSave)
        );
      } catch {}

      // Update user onboarding metadata in Clerk and reload session
      await completeOnboarding(model).catch(() => {});
      await user?.reload().catch(() => {});

      toast.success("Workspace created!");
    } catch (err: unknown) {
      console.error("Failed to create project", err);
      isCreatingRef.current = false;
      const msg =
        err instanceof Error ? err.message : "Failed to create project. Please try again.";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  const handleGoToDashboard = useCallback((explicitId?: string | null) => {
    let targetId = explicitId || createdProjectId;

    if (!targetId) {
      try {
        const saved = localStorage.getItem(ONBOARDING_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.projectId) targetId = parsed.projectId;
        }
      } catch {}
    }

    try {
      localStorage.removeItem(ONBOARDING_STORAGE_KEY);
      localStorage.removeItem(ONBOARDING_PROMPT_KEY);
    } catch {}

    if (targetId) {
      window.location.href = `/projects/${targetId}`;
    } else {
      window.location.href = "/";
    }
  }, [createdProjectId]);

  return (
    // Forced dark — this design isn't meant to adapt to light mode.
    <div className="dark flex min-h-screen bg-card">
      <TerminalPanel
        stepKey={stepKey}
        authMethod={authMethod}
        githubConnected={isGithubConnected}
        model={model}
        projectName={projectName}
        created={created}
        userIdentifier={
          user?.primaryEmailAddress?.emailAddress || user?.username || undefined
        }
        prompt={prompt || undefined}
      />

      <div className="flex flex-1 flex-col px-8 pt-14 md:px-18 md:pt-20">
        {/* Onboarding context indicator showing user's original prompt */}
        {prompt && !created && (
          <div className="mb-4 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-xs text-foreground/90 max-w-fit shadow-xs">
            <Sparkles className="size-3 text-brand shrink-0" />
            <span className="text-muted-foreground text-[11px]">Building:</span>
            <span className="font-medium text-foreground truncate max-w-[280px] sm:max-w-[440px]">
              &ldquo;{prompt}&rdquo;
            </span>
          </div>
        )}

        <StepHeader flow={flow} stepKey={stepKey} />

        <div className="flex-1">
          {stepKey === "welcome" && (
            <WelcomeStep
              onNext={goNext}
              prompt={prompt || undefined}
              projectName={projectName}
            />
          )}

          {stepKey === "features" && (
            <FeaturesStep onNext={goNext} onBack={goBack} />
          )}

          {stepKey === "auth" && (
            <AuthStep onAuthed={handleAuthed} onBack={goBack} />
          )}

          {stepKey === "github" && (
            <GithubStep
              connected={isGithubConnected}
              username={githubUsername}
              avatarUrl={githubAvatarUrl}
              onLink={handleLinkGithub}
              onUnlink={handleUnlinkGithub}
              loading={githubLoading}
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
              onSkip={handleSkip}
              creating={creating}
              skipping={skipping}
              created={created}
              model={model}
              githubConnected={isGithubConnected}
              onGoToDashboard={handleGoToDashboard}
              prompt={prompt || undefined}
              projectId={createdProjectId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
