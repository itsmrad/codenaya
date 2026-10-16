"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowUp,
  Sparkles,
  Plus,
  Mic,
  ChevronDown,
  Check,
} from "lucide-react";
import { useAuth, useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import ky from "ky";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ONBOARDING_PROMPT_KEY,
  ONBOARDING_STORAGE_KEY,
  type ModelId,
  type OnboardingState,
} from "@/components/onboarding/types";
import { generateProjectNameFromPrompt } from "@/lib/project-utils";

const STARTER_PROMPTS = [
  {
    icon: "🍅",
    label: "Pomodoro App",
    prompt: "Build me a clean, aesthetic pomodoro timer web app with focus sessions, break alarms, ambient sounds, and daily productivity streaks.",
  },
  {
    icon: "⚡",
    label: "SaaS Platform",
    prompt: "Build me a modern SaaS website for an AI-powered productivity platform with authentication, a dashboard, and subscription plans.",
  },
  {
    icon: "🤖",
    label: "AI Chat Assistant",
    prompt: "Build an AI chat assistant web app with conversation history, markdown formatting, syntax highlighted code blocks, and model switching.",
  },
  {
    icon: "📊",
    label: "Analytics Dashboard",
    prompt: "Build a sleek real-time analytics dashboard with interactive revenue charts, user conversion metrics, and dark mode design.",
  },
  {
    icon: "🛍️",
    label: "E-Commerce Store",
    prompt: "Build a minimalist e-commerce storefront for mechanical keyboards with product filters, a shopping cart drawer, and checkout preview.",
  },
];

const TEMPLATE_OPTIONS = [
  { id: "fullstack", label: "Full-Stack SaaS (Next.js)", desc: "Auth, database, and API routing" },
  { id: "landing", label: "Marketing Landing Page", desc: "High conversion, responsive and animated" },
  { id: "dashboard", label: "Interactive Dashboard", desc: "Charts, metrics, and data tables" },
  { id: "tool", label: "Web Utility / Mini-App", desc: "Fast, focused productivity tool" },
];

export function PromptInputHero() {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<ModelId>("claude-sonnet-4");
  const [submitting, setSubmitting] = useState(false);
  const [existingDraft, setExistingDraft] = useState<{
    prompt: string;
    projectName: string;
  } | null>(null);

  // Check for any ongoing uncompleted onboarding draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ONBOARDING_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as OnboardingState;
        if (parsed.prompt && !parsed.created) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setExistingDraft({
            prompt: parsed.prompt,
            projectName: parsed.projectName || "In-progress Project",
          });
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const handleSelectStarter = (starterPrompt: string) => {
    setPrompt(starterPrompt);
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        120
      )}px`;
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    const projectName = generateProjectNameFromPrompt(trimmed);

    // Persist immediately to localStorage
    const onboardingState: OnboardingState = {
      stepKey: "welcome",
      authMethod: null,
      githubConnected: false,
      model,
      projectName,
      template: 0,
      prompt: trimmed,
    };

    try {
      localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify(onboardingState)
      );
      localStorage.setItem(ONBOARDING_PROMPT_KEY, trimmed);
    } catch (err) {
      console.error("Failed to store onboarding state in localStorage", err);
    }

    // If user is already authenticated AND has already completed onboarding,
    // they don't need to go through onboarding again — create directly and go to project!
    if (isSignedIn && user?.publicMetadata?.hasCompletedOnboarding) {
      try {
        const res = await ky
          .post("/api/projects/create-with-prompt", {
            json: { prompt: trimmed, projectName },
          })
          .json<{ projectId: string }>();

        toast.success(`Project "${projectName}" created!`);
        router.push(`/projects/${res.projectId}`);
        return;
      } catch (err) {
        console.error("Direct project creation failed, redirecting to onboarding", err);
        // Fall back to onboarding flow
      }
    }

    // For new users (or users who have not completed onboarding), automatically redirect to onboarding
    toast.success("Project initialised! Preparing setup…");
    router.push("/onboarding");
  };

  const handleResumeDraft = () => {
    router.push("/onboarding");
  };

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col items-center">
      {/* Resume draft banner if one exists */}
      <AnimatePresence>
        {existingDraft && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            className="mb-3.5 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand/10 border border-brand/25 text-xs text-foreground/90 backdrop-blur-md shadow-sm hover:border-brand/40 transition-colors"
          >
            <span className="size-1.5 rounded-full bg-brand animate-ping" />
            <span className="text-muted-foreground font-normal">Draft in progress:</span>
            <span className="font-semibold text-brand truncate max-w-[200px]">
              {existingDraft.projectName}
            </span>
            <button
              onClick={handleResumeDraft}
              className="ml-1 inline-flex items-center gap-1 font-medium text-brand hover:underline cursor-pointer"
            >
              Resume setup →
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Lovable-inspired Prompt Box */}
      <div className="relative w-full group">
        {/* Soft glowing ambient aura behind the box */}
        <div className="absolute -inset-1 rounded-[32px] bg-gradient-to-r from-blue-500/20 via-brand/20 to-purple-500/20 blur-xl opacity-60 group-hover:opacity-100 transition-opacity duration-500 -z-10" />

        <div className="relative rounded-[24px] bg-card/90 dark:bg-card/85 backdrop-blur-xl border border-border/80 shadow-2xl shadow-brand/10 p-2.5 sm:p-3.5 transition-all duration-300 focus-within:border-brand/60 focus-within:ring-4 focus-within:ring-brand/15">
          {/* Textarea */}
          <textarea
            ref={textareaRef}
            rows={2}
            value={prompt}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            placeholder="Ask Codenaya to build... (e.g. 'Build a modern SaaS landing page with dark mode, animations, and pricing plans')"
            className="w-full bg-transparent text-sm sm:text-base text-foreground placeholder:text-muted-foreground/60 resize-none outline-none font-normal leading-relaxed pr-2 pt-0.5 transition-all"
            style={{ minHeight: "56px" }}
          />

          {/* Action Footer */}
          <div className="mt-1.5 pt-1.5 border-t border-border/40 flex items-center justify-between gap-2">
            {/* Left Controls */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* Template dropdown / plus */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Starter templates"
                    className="size-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Plus className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 p-1.5">
                  <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    Project Template
                  </div>
                  {TEMPLATE_OPTIONS.map((tpl) => (
                    <DropdownMenuItem
                      key={tpl.id}
                      onClick={() => handleSelectStarter(`Build a ${tpl.label.toLowerCase()} with high performance and modern UI.`)}
                      className="flex flex-col items-start gap-0.5 cursor-pointer py-1.5"
                    >
                      <span className="text-xs font-medium text-foreground">{tpl.label}</span>
                      <span className="text-[11px] text-muted-foreground">{tpl.desc}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Model Selector Pill */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-7 px-2.5 rounded-full bg-muted/50 hover:bg-muted text-[11px] font-medium text-foreground/85 hover:text-foreground flex items-center gap-1.5 transition-colors border border-border/40"
                  >
                    <Sparkles className="size-3 text-brand" />
                    <span>{model === "claude-sonnet-4" ? "Claude Sonnet 4" : "Gemini 2.0 Flash"}</span>
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem
                    onClick={() => setModel("claude-sonnet-4")}
                    className="flex items-center justify-between cursor-pointer text-xs"
                  >
                    <span>Claude Sonnet 4</span>
                    {model === "claude-sonnet-4" && <Check className="size-3.5 text-brand" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setModel("gemini-2.0-flash")}
                    className="flex items-center justify-between cursor-pointer text-xs"
                  >
                    <span>Gemini 2.0 Flash</span>
                    {model === "gemini-2.0-flash" && <Check className="size-3.5 text-brand" />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Right Controls */}
            <div className="flex items-center gap-2">
              {/* Mic Icon */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => toast.info("Voice input ready. Type or speak your prompt.")}
                    className="size-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Mic className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Voice prompt</TooltipContent>
              </Tooltip>

              {/* Up-Arrow Submit Button */}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!prompt.trim() || submitting}
                aria-label="Submit project prompt"
                className={`size-8 sm:size-9 rounded-full flex items-center justify-center transition-all duration-200 ${
                  prompt.trim() && !submitting
                    ? "bg-foreground text-background dark:bg-foreground dark:text-background hover:scale-105 active:scale-95 shadow-md shadow-brand/20 cursor-pointer"
                    : "bg-muted text-muted-foreground/40 cursor-not-allowed"
                }`}
              >
                {submitting ? (
                  <div className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <ArrowUp className="size-4 stroke-[2.5]" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Suggestion Chips */}
      <div className="mt-2.5 sm:mt-3 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <span className="text-[11px] font-mono text-muted-foreground mr-1 hidden sm:inline">
          Try:
        </span>
        {STARTER_PROMPTS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => handleSelectStarter(item.prompt)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-card/60 hover:bg-card border border-border/50 text-[11px] sm:text-xs text-foreground/80 hover:text-foreground transition-all duration-150 hover:border-brand/40 shadow-xs cursor-pointer"
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
