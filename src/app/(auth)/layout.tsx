import { Check } from "lucide-react";

import { PublicShell } from "@/components/landing/public-shell";
import { Reveal } from "@/components/landing/reveal";
import { GridCross } from "@/components/landing/section-header";

const POINTS = [
  "Unlimited runs on your own AI key",
  "Your app runs in a cloud sandbox, nothing to install",
  "Export to GitHub or download a ZIP anytime",
];

/** Sign in and sign up: a short pitch beside the Clerk card, on the landing grid. */
const AuthLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <PublicShell>
      <div className="grid border-b border-border lg:min-h-[calc(100vh-8rem)] lg:grid-cols-[1fr_1.1fr]">
        <div className="relative hidden flex-col justify-between border-r border-border lg:flex">
          <div className="flex h-11 items-center gap-3 border-b border-border px-8 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            <span aria-hidden className="h-3.5 w-0.5 bg-brand" />[ Codenaya ]
          </div>
          <Reveal className="px-8 py-16">
            <p className="text-5xl font-semibold leading-[1.02] tracking-[-0.045em] text-foreground">
              Build with AI.
              <br />
              Ship from your <span className="text-brand">browser.</span>
            </p>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted-foreground">
              A browser IDE with an AI agent that writes your code and runs it in a live preview.
            </p>
          </Reveal>
          <ul className="border-t border-border">
            {POINTS.map((point, i) => (
              <li key={point} className="border-b border-border last:border-b-0">
                <Reveal delay={0.15 + i * 0.08} className="flex items-center gap-3 px-8 py-4 text-sm text-foreground">
                  <Check className="size-4 shrink-0 text-brand" />
                  {point}
                </Reveal>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center justify-center overflow-hidden px-4 py-16">
          {/* Dotted field and a soft glow behind the card */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--color-foreground)_1px,transparent_1px)] [background-size:18px_18px] opacity-[0.1] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_50%,black,transparent)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 h-80 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/15 blur-[100px]"
          />
          <GridCross className="-top-[5px] -left-[5px] max-lg:hidden" />
          <Reveal className="relative z-10">{children}</Reveal>
        </div>
      </div>
    </PublicShell>
  );
};

export default AuthLayout;
