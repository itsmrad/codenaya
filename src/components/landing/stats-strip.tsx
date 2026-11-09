"use client";

import { Terminal, Bot, Zap, LockOpen } from "lucide-react";
import { AGENT_MODELS } from "@/features/conversations/agent-models";

const STATS = [
  {
    icon: Terminal,
    value: "100%",
    label: "In-Browser Sandbox",
    description: "Zero local installation or environment configuration required",
  },
  {
    icon: Bot,
    value: `${AGENT_MODELS.length}+`,
    label: "Frontier AI Models",
    description: "Switch seamlessly between Claude, GPT, Gemini and open models",
  },
  {
    icon: Zap,
    value: "< 1.2s",
    label: "Streaming Latency",
    description: "Sub-second time to first code edit with real-time diff streaming",
  },
  {
    icon: LockOpen,
    value: "0",
    label: "Vendor Lock-in",
    description: "Bring your own API key, push to GitHub, or download complete ZIP",
  },
];

export const LandingStatsStrip = () => {
  return (
    <section aria-label="Key metrics" className="relative py-10 md:py-14 border-y border-border/40">
      <div className="max-w-6xl mx-auto px-6 md:px-8">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          {STATS.map((stat) => (
            <div
              key={stat.label}
              className="relative flex flex-col space-y-2 p-5 rounded-xl border border-border bg-card shadow-xs hover:border-brand/50 transition-all duration-200"
            >
              <div className="flex items-center gap-2">
                <stat.icon className="size-4 text-brand" />
                <span className="text-3xl sm:text-4xl font-extrabold tracking-tight font-mono text-foreground">
                  {stat.value}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-foreground tracking-tight">
                {stat.label}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {stat.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
