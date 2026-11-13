"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AI_PROVIDER_IDS, AI_PROVIDERS } from "@/features/ai-providers/registry";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./section-header";

/** Each provider's default model label, falling back to its model count. */
const detailFor = (id: (typeof AI_PROVIDER_IDS)[number]) => {
  const provider = AI_PROVIDERS[id];
  if (!provider.models.length) return "Any OpenAI-compatible endpoint";
  const fallback = provider.models[0];
  const model = provider.models.find((m) => m.id === provider.defaultModel) ?? fallback;
  return `${model.label} · ${provider.models.length} models`;
};

const CELLS = [
  { name: "Codenaya", detail: "Models included, nothing to set up", tag: "Credits", highlight: true },
  ...AI_PROVIDER_IDS.map((id) => ({
    name: AI_PROVIDERS[id].label.replace(" (OpenAI-compatible)", ""),
    detail: detailFor(id),
    tag: "BYOK",
    highlight: false,
  })),
];

export const LandingProviders = () => (
  <section className="border-b border-border">
    <SectionHeader
      index={3}
      label="Your key or ours"
      title="Bring any key."
      accent="Or none"
      description="Start free with 300 credits a month. Add your own provider key for unlimited runs on any plan. You pay your provider directly."
    />
    <ul className="grid grid-cols-2 border-t border-border lg:grid-cols-3">
      {CELLS.map((cell, i) => (
        <li
          key={cell.name}
          className={cn(
            "relative flex min-h-36 flex-col gap-2 border-border p-6 md:p-8",
            "max-lg:odd:border-r max-lg:[&:nth-last-child(n+3)]:border-b",
            "lg:[&:not(:nth-child(3n))]:border-r lg:[&:nth-last-child(n+4)]:border-b",
            cell.highlight && "bg-brand/[0.06]",
          )}
        >
          {cell.highlight && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand" />}
          <div className="flex items-start justify-between gap-3">
            <span className="text-base font-semibold text-foreground">{cell.name}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em]",
                cell.highlight ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {cell.tag}
            </span>
          </div>
          <span className="font-mono text-[12px] text-muted-foreground">{cell.detail}</span>
          {i === 0 && (
            <Link
              href="/pricing"
              className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"
            >
              See pricing <ArrowRight className="size-3" />
            </Link>
          )}
        </li>
      ))}
    </ul>
    <div className="grid border-t border-border md:grid-cols-[1fr_auto]">
      <p className="px-6 py-5 text-sm text-muted-foreground md:px-8">
        <span className="font-mono text-foreground">[*]</span> Keys are stored with envelope encryption. After you save
        one, you only ever see its last four characters.
      </p>
      <Link
        href="/docs"
        className="flex items-center gap-2 border-border px-6 py-5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 max-md:border-t md:border-l md:px-8"
      >
        How keys work <ArrowRight className="size-4" />
      </Link>
    </div>
  </section>
);
