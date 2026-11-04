"use client";

import { Check, X } from "lucide-react";

interface ComparisonRow {
  feature: string;
  description: string;
  codenaya: boolean | string;
  localIde: boolean | string;
  chatbots: boolean | string;
  sandboxes: boolean | string;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Zero Local Environment Setup",
    description: "Start coding immediately without installing Node, Git, or Docker",
    codenaya: true,
    localIde: false,
    chatbots: true,
    sandboxes: true,
  },
  {
    feature: "In-Browser Sandbox & Terminal",
    description: "Live hot-reload preview with a real bash terminal in your browser",
    codenaya: true,
    localIde: false,
    chatbots: false,
    sandboxes: "Limited",
  },
  {
    feature: "Autonomous Multi-File Edits",
    description: "Plans and edits multiple files across components, styles, and backends",
    codenaya: true,
    localIde: true,
    chatbots: false,
    sandboxes: true,
  },
  {
    feature: "Live Web Documentation Grounding",
    description: "Scrapes latest upstream documentation via Firecrawl to avoid hallucinations",
    codenaya: "Built-in (Firecrawl)",
    localIde: false,
    chatbots: false,
    sandboxes: false,
  },
  {
    feature: "Bring Your Own Key (BYOK)",
    description: "Use your own OpenRouter, OpenAI, or Anthropic keys with zero token markup",
    codenaya: true,
    localIde: "Varies",
    chatbots: false,
    sandboxes: false,
  },
  {
    feature: "GitHub 2-Way Sync & ZIP Export",
    description: "Import from any repo, export to GitHub, or download complete ZIP archive",
    codenaya: true,
    localIde: true,
    chatbots: false,
    sandboxes: "Paid tier",
  },
  {
    feature: "Full Mobile & iPad Support",
    description: "Review, edit code, and prompt the agent from a tablet or phone browser",
    codenaya: true,
    localIde: false,
    chatbots: true,
    sandboxes: false,
  },
  {
    feature: "Open Modern Tech Stack",
    description: "Built with standard TypeScript, React 19, Next.js, and open ecosystem tools",
    codenaya: true,
    localIde: true,
    chatbots: false,
    sandboxes: "Proprietary",
  },
];

const RenderCell = ({ value, isCodenaya }: { value: boolean | string; isCodenaya?: boolean }) => {
  if (value === true) {
    return (
      <div className={`inline-flex items-center justify-center size-6 rounded-full ${isCodenaya ? "bg-brand/20 text-brand" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"}`}>
        <Check aria-hidden className="size-4 stroke-[2.5]" />
        <span className="sr-only">Yes</span>
      </div>
    );
  }
  if (value === false) {
    return (
      <div className="inline-flex items-center justify-center size-6 rounded-full bg-muted text-muted-foreground/60">
        <X aria-hidden className="size-3.5" />
        <span className="sr-only">No</span>
      </div>
    );
  }
  return (
    <span className={`text-xs font-mono font-medium ${isCodenaya ? "text-brand-text font-bold" : "text-muted-foreground"}`}>
      {value}
    </span>
  );
};

export const LandingComparison = () => {
  return (
    <section aria-label="Feature comparison" className="relative py-14 md:py-24 border-t border-border/40">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        <div className="text-center mb-12 md:mb-16">
          <p className="text-xs uppercase tracking-[0.25em] text-brand-text font-mono mb-4">
            Comparison
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Why developers choose Codenaya
          </h2>
          <p className="mt-4 text-base md:text-lg text-muted-foreground max-w-2xl mx-auto">
            See how an in-browser AI IDE with live documentation grounding compares to local editors, AI chatbots, and closed sandboxes.
          </p>
        </div>

        {/* Comparison Table */}
        <div className="overflow-x-auto rounded-2xl border border-border bg-card shadow-xl">
          <table className="w-full border-collapse text-left text-sm bg-card">
            <thead>
              <tr className="border-b border-border bg-muted">
                <th className="py-4 px-6 font-semibold text-foreground min-w-[240px]">
                  Feature & Capability
                </th>
                <th className="py-4 px-4 font-bold text-brand min-w-[150px] text-center bg-card border-x border-brand/30 shadow-xs">
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-base text-foreground font-extrabold">Codenaya</span>
                    <span className="text-[10px] font-mono text-brand uppercase">In-Browser IDE</span>
                  </div>
                </th>
                <th className="py-4 px-4 font-semibold text-muted-foreground min-w-[130px] text-center">
                  Local IDEs
                  <span className="block text-[10px] font-mono font-normal">Cursor / VS Code</span>
                </th>
                <th className="py-4 px-4 font-semibold text-muted-foreground min-w-[130px] text-center">
                  Web Chatbots
                  <span className="block text-[10px] font-mono font-normal">ChatGPT / Claude</span>
                </th>
                <th className="py-4 px-4 font-semibold text-muted-foreground min-w-[130px] text-center">
                  Cloud Sandboxes
                  <span className="block text-[10px] font-mono font-normal">v0 / Bolt</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 bg-card">
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.feature} className="hover:bg-muted/40 transition-colors">
                  <td className="py-4 px-6 bg-card">
                    <div className="font-medium text-foreground">{row.feature}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{row.description}</div>
                  </td>
                  <td className="py-4 px-4 text-center bg-card border-x border-brand/20">
                    <div className="flex justify-center">
                      <RenderCell value={row.codenaya} isCodenaya />
                    </div>
                  </td>
                  <td className="py-4 px-4 text-center bg-card">
                    <div className="flex justify-center">
                      <RenderCell value={row.localIde} />
                    </div>
                  </td>
                  <td className="py-4 px-4 text-center bg-card">
                    <div className="flex justify-center">
                      <RenderCell value={row.chatbots} />
                    </div>
                  </td>
                  <td className="py-4 px-4 text-center bg-card">
                    <div className="flex justify-center">
                      <RenderCell value={row.sandboxes} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
