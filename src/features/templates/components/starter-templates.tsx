"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { Loader2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ProjectCover } from "@/components/project-cover";
import { SIGN_UP_URL } from "@/features/auth/constants";
import { useCreateProjectFromPrompt } from "@/features/projects/hooks/use-create-project-from-prompt";
import { CARD_CLASS } from "@/features/showcase/components/showcase-card";
import { authRedirectUrl } from "@/features/showcase/hooks/use-remix";
import { cn } from "@/lib/utils";

import { STARTER_TEMPLATES, type StarterTemplate } from "../templates";
import { savePendingTemplate } from "../utils/pending-template";

interface TemplateCardsProps {
  onSelect: (template: StarterTemplate) => void;
  /** The template whose project is being created. */
  pendingId?: string;
  disabled?: boolean;
}

/** The template cards: a sideways-scrolling row on phones, a grid above. */
const TemplateCards = ({ onSelect, pendingId, disabled }: TemplateCardsProps) => (
  <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
    {STARTER_TEMPLATES.map((template) => (
      <div key={template.id} className="w-[78%] shrink-0 snap-start sm:w-auto">
        <button
          type="button"
          aria-label={`Use the ${template.title} template`}
          onClick={() => onSelect(template)}
          disabled={disabled}
          className={cn(CARD_CLASS, "h-full disabled:cursor-default disabled:hover:shadow-none")}
        >
          <div className="relative aspect-video w-full overflow-hidden bg-muted/30">
            <ProjectCover seed={template.id} className="size-full" />
            {pendingId === template.id && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 text-xs font-medium backdrop-blur-sm">
                <Loader2Icon className="size-4 animate-spin" />
                Creating project…
              </div>
            )}
          </div>
          <div className="space-y-2 p-4">
            <h3 className="text-sm font-semibold text-foreground transition-colors group-hover:text-brand">
              {template.title}
            </h3>
            <p className="line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
            <div className="flex flex-wrap gap-1">
              {template.techStack.map((tag) => (
                <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </button>
      </div>
    ))}
  </div>
);

/** Creates the picked template's project and opens it in the IDE. */
const SignedInTemplateCards = () => {
  const { createProject, isSubmitting } = useCreateProjectFromPrompt();
  const [pendingId, setPendingId] = useState<string>();

  const handleSelect = async (template: StarterTemplate) => {
    setPendingId(template.id);
    await createProject(template.prompt, template.id);
    setPendingId(undefined);
  };

  return (
    <TemplateCards
      onSelect={handleSelect}
      pendingId={pendingId}
      disabled={isSubmitting}
    />
  );
};

/** Keeps the picked template and sends the visitor to sign up first. */
const SignedOutTemplateCards = ({ disabled }: { disabled: boolean }) => {
  const router = useRouter();

  const handleSelect = (template: StarterTemplate) => {
    savePendingTemplate(template.id);
    router.push(authRedirectUrl(SIGN_UP_URL, "/"));
  };

  return <TemplateCards onSelect={handleSelect} disabled={disabled} />;
};

interface StarterTemplatesProps {
  title: string;
  description: string;
}

/**
 * The official starter templates (#119), for the dashboard and /showcase.
 * Picking one creates a project seeded with the template's files and starts
 * the agent on its curated prompt.
 */
export const StarterTemplates = ({ title, description }: StarterTemplatesProps) => {
  const { isLoading, isAuthenticated } = useConvexAuth();

  return (
    <section aria-labelledby="templates-heading">
      <div className="mb-4">
        <h2 id="templates-heading" className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {isAuthenticated ? (
        <SignedInTemplateCards />
      ) : (
        <SignedOutTemplateCards disabled={isLoading} />
      )}
    </section>
  );
};
