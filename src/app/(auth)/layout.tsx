import { CheckIcon } from "lucide-react";

import { MarketingNavbar } from "@/components/marketing-navbar";
import { GridPattern } from "@/components/landing/grid-pattern";
import { PendingStartNote } from "@/features/auth/components/pending-start-note";
import { AGENT_MODELS } from "@/features/conversations/agent-models";

/** Why sign up, beside the card on wide screens (#252). */
const BENEFITS = [
  "Unlimited runs on your own AI key (BYOK)",
  `${AGENT_MODELS.length} models, including Claude, GPT and Gemini`,
  "Import from GitHub, push back, or download a ZIP",
];

const AuthLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <MarketingNavbar />
      <main className="relative flex-1 flex items-center justify-center overflow-hidden px-4 py-12">
        <GridPattern />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.08),transparent_70%)] dark:bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.12),transparent_70%)]" />
        <div className="relative z-10 grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-4">
            <p className="text-center text-sm text-muted-foreground lg:hidden">
              Build apps with AI, right in your browser.
            </p>
            <PendingStartNote />
            {children}
          </div>
          <aside aria-label="Why Codenaya" className="hidden lg:flex flex-col gap-6">
            <h2 className="text-3xl font-bold tracking-tighter text-foreground">
              Build apps with AI, right in your browser.
            </h2>
            <ul className="flex flex-col gap-3 text-base text-muted-foreground">
              {BENEFITS.map((benefit) => (
                <li key={benefit} className="flex items-start gap-2.5">
                  <CheckIcon aria-hidden className="mt-1 size-4 shrink-0 text-brand" />
                  {benefit}
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default AuthLayout;
