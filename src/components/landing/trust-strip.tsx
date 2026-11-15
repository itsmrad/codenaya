"use client";

import { useQuery } from "convex/react";
import { Star } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { VendorIcon } from "@/components/vendor-icon";
import { AGENT_MODELS } from "@/features/conversations/agent-models";
import { GITHUB_REPO_URL } from "@/lib/site";
import { HideOnError } from "./community-strip";
import { formatProjectsBuilt, supportedProviders } from "./trust-signals";

const PROVIDERS = supportedProviders(AGENT_MODELS);
const ENDPOINTS = "or any OpenRouter / OpenAI-compatible endpoint";

const ProjectsBuilt = () => {
  const label = formatProjectsBuilt(useQuery(api.stats.projectsBuilt));
  return label ? (
    <span className="inline-flex items-center gap-3 after:content-['·']">
      {label}
    </span>
  ) : null;
};

export const TrustStrip = ({ githubStars }: { githubStars: number | null }) => (
  <div
    role="group"
    aria-label="Supported providers and community"
    className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs leading-5 text-muted-foreground"
  >
    <a
      href="#providers"
      aria-label={`Works with ${PROVIDERS.join(", ")}, ${ENDPOINTS}`}
      title={`Works with ${PROVIDERS.join(", ")}, ${ENDPOINTS}`}
      className="inline-flex basis-full items-center justify-center gap-2 whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-ring md:basis-auto"
    >
      <span>Works with</span>
      {PROVIDERS.map((provider) => (
        <span key={provider} title={provider}>
          <VendorIcon vendor={provider} />
          <span className="sr-only">{provider}</span>
        </span>
      ))}
      <span aria-hidden>+</span>
      <span className="sr-only">{ENDPOINTS}</span>
    </a>
    <span className="inline-flex items-center gap-3 whitespace-nowrap md:before:content-['·']">
      <HideOnError>
        <ProjectsBuilt />
      </HideOnError>
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground focus-visible:outline-ring"
      >
        <Star aria-hidden className="size-3.5" />
        {githubStars === null ? "GitHub" : `${githubStars.toLocaleString("en-US")} GitHub stars`}
      </a>
    </span>
  </div>
);
