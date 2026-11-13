import type { Metadata } from "next";
import Link from "next/link";
import { Check, Minus } from "lucide-react";

import { PublicShell } from "@/components/landing/public-shell";
import { CountUp, Reveal } from "@/components/landing/reveal";
import { SectionHeader } from "@/components/landing/section-header";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SIGN_UP_URL } from "@/features/auth/constants";
import { formatCredits, PLANS, TOP_UP, type Plan } from "@/features/billing/plans";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing — Codenaya",
  description:
    "Start free with 300 credits a month, or go Pro for 2,000. Bring your own key for unlimited runs on any plan.",
};

const { free, pro } = PLANS;
const topUp = `$${TOP_UP.priceUsd} for ${formatCredits(TOP_UP.credits)} credits`;

const PLAN_CARDS: { plan: Plan; description: string; features: string[] }[] = [
  {
    plan: free,
    description: "Everything you need to build and ship.",
    features: [
      `Up to ${formatCredits(free.dailyCreditCap ?? 0)} credits a day`,
      "Default model",
      "Unlimited runs with your own key (BYOK)",
      "GitHub import & export, ZIP download",
      "Private projects, skills & integrations",
    ],
  },
  {
    plan: pro,
    description: "More credits and every model.",
    features: [
      "No daily cap",
      "All models",
      `Top-ups: ${topUp}`,
      "Unlimited runs with your own key (BYOK)",
      "Everything in Free",
    ],
  },
];

// `true` renders a check, `false` a dash.
const COMPARISON: { feature: string; free: string | boolean; pro: string | boolean }[] = [
  {
    feature: "Monthly credits",
    free: formatCredits(free.monthlyCredits),
    pro: formatCredits(pro.monthlyCredits),
  },
  {
    feature: "Daily limit",
    free: `${formatCredits(free.dailyCreditCap ?? 0)} credits`,
    pro: "No cap",
  },
  { feature: "Models", free: "Default model", pro: "All models" },
  { feature: "Credit top-ups", free: false, pro: topUp },
  { feature: "Bring your own key (BYOK)", free: "Unlimited", pro: "Unlimited" },
  { feature: "GitHub import & export", free: true, pro: true },
  { feature: "Download as ZIP", free: true, pro: true },
  { feature: "Private projects", free: true, pro: true },
  { feature: "Skills & integrations", free: true, pro: true },
];

const FAQ: { question: string; answer: string }[] = [
  {
    question: "What is a credit?",
    answer:
      "A credit is $0.01 of AI usage. Each run costs credits based on the model and how much work it does, so a small edit costs less than building a new feature.",
  },
  {
    question: "What counts as a run?",
    answer:
      "A run is one message to the agent and everything it does to answer it: reading files, writing code and running commands. You are charged for the AI usage the run actually needed.",
  },
  {
    question: "What is BYOK?",
    answer:
      "Bring your own key. Add an OpenRouter, OpenAI or Anthropic key, or any OpenAI-compatible endpoint, in Settings. Runs on your key use no credits and have no daily limit, on every plan. You pay your provider directly.",
  },
  {
    question: "What happens if my key stops working?",
    answer:
      "The run stops with a clear error. Codenaya never switches to your credits without asking.",
  },
  {
    question: "Can I buy more credits?",
    answer: `Pro members can buy top-ups: ${topUp}. Top-ups are only for paid plans. On Free, you can always add your own key for unlimited runs.`,
  },
  {
    question: "When can I upgrade to Pro?",
    answer:
      "Paid plans are coming soon. Until then, everyone is on Free, and runs on your own key are unlimited.",
  },
];

const CREDIT_FACTS: { prefix?: string; value?: number; suffix: string; caption: string }[] = [
  {
    prefix: "$0.01",
    suffix: " / credit",
    caption: "One credit is a cent of AI usage. A small edit costs less than a new feature.",
  },
  {
    value: free.monthlyCredits,
    suffix: " free",
    caption: `Credits every month on ${free.name}, up to ${formatCredits(free.dailyCreditCap ?? 0)} a day.`,
  },
  {
    value: 0,
    suffix: " credits",
    caption: "Used by runs on your own key, with no daily limit, on every plan.",
  },
];

const ComparisonValue = ({ value }: { value: string | boolean }) => {
  if (value === true) {
    return <Check aria-label="Included" className="size-4 text-muted-foreground" />;
  }
  if (value === false) {
    return <Minus aria-label="Not included" className="size-4 text-muted-foreground" />;
  }
  return <>{value}</>;
};

// Public: a static page, so signed-out visitors can see the plans.
const PricingPage = () => {
  return (
    <PublicShell>
      <section className="border-b border-border">
        <SectionHeader
          as="h1"
          label="Pricing"
          title="Start free."
          accent="Bring your own key"
          description="Use our credits, or run the agent on your own key with no limits. BYOK is free on every plan."
        />

        {/* Plans */}
        <div className="grid border-t border-border md:grid-cols-2">
          {PLAN_CARDS.map(({ plan, description, features }, i) => (
            <Reveal
              key={plan.id}
              delay={i * 0.12}
              className={cn(
                "spotlight flex flex-col p-6 md:p-10",
                plan.id === "free"
                  ? "border-border max-md:border-b md:border-r"
                  : "bg-brand/[0.04]",
              )}
            >
              <div data-testid={`plan-${plan.id}`} className="flex flex-1 flex-col">
                {plan.id === "pro" && (
                  <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-brand" />
                )}
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-foreground">{plan.name}</h2>
                  {plan.id === "pro" && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                <p className="mt-8 flex items-baseline gap-1">
                  <span className="font-mono text-5xl font-medium tracking-tight tabular-nums text-foreground">
                    $<CountUp to={plan.priceUsdPerMonth} />
                  </span>
                  <span className="text-sm text-muted-foreground">/month</span>
                </p>
                <p className="mt-2 text-sm font-medium text-foreground">
                  {formatCredits(plan.monthlyCredits)} credits a month
                </p>
                <ul className="mt-8 flex flex-1 flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-8">
                  {plan.id === "free" ? (
                    <Button
                      asChild
                      className="h-10 w-full rounded-md bg-brand text-brand-foreground shadow-[inset_0_-4px_8px_rgb(0_0_0/0.12)] hover:bg-brand/90"
                    >
                      <Link href={SIGN_UP_URL}>Get started</Link>
                    </Button>
                  ) : (
                    // Checkout ships with billing (#105).
                    <Button className="h-10 w-full rounded-md" variant="outline" disabled>
                      Coming soon
                    </Button>
                  )}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground md:px-10">
          <span className="font-mono text-foreground">[*]</span> Need more credits? Pro members can
          buy top-ups: {topUp}. Top-ups are for paid plans only.
        </p>
      </section>

      {/* How credits work */}
      <section className="border-b border-border">
        <SectionHeader
          label="Credits"
          title="How credits"
          accent="work"
          description="You pay for the AI work a run actually needs. Nothing is charged for runs on your own key."
        />
        <dl className="grid border-t border-border md:grid-cols-3">
          {CREDIT_FACTS.map((fact, i) => (
            <Reveal
              key={fact.caption}
              delay={i * 0.1}
              className="flex flex-col gap-3 border-border p-6 not-last:border-b md:p-8 md:not-last:border-r md:not-last:border-b-0"
            >
              <dt className="text-sm leading-relaxed text-muted-foreground">{fact.caption}</dt>
              <dd className="order-first font-mono text-4xl font-medium tracking-tight tabular-nums text-foreground md:text-5xl">
                {fact.prefix}
                {fact.value === undefined ? null : <CountUp to={fact.value} />}
                <span className="text-[0.6em] text-muted-foreground">{fact.suffix}</span>
              </dd>
            </Reveal>
          ))}
        </dl>
      </section>

      {/* Comparison */}
      <section className="border-b border-border">
        <SectionHeader label="Compare" title="Compare" accent="plans" />
        <div className="border-t border-border px-2 md:px-4">
          <Reveal>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4 font-mono text-[11px] uppercase tracking-[0.14em]">
                    Feature
                  </TableHead>
                  <TableHead className="px-4 font-mono text-[11px] uppercase tracking-[0.14em]">
                    {free.name}
                  </TableHead>
                  <TableHead className="px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-text">
                    {pro.name}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARISON.map((row) => (
                  <TableRow key={row.feature}>
                    <TableCell className="whitespace-normal px-4 py-4 font-medium">
                      {row.feature}
                    </TableCell>
                    <TableCell className="whitespace-normal px-4 py-4">
                      <ComparisonValue value={row.free} />
                    </TableCell>
                    <TableCell className="whitespace-normal px-4 py-4">
                      <ComparisonValue value={row.pro} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-b border-border">
        <div className="grid lg:grid-cols-[2fr_3fr]">
          <div className="border-border lg:border-r">
            <SectionHeader label="FAQ" title="Credits and keys," accent="explained" />
          </div>
          <div className="border-border max-lg:border-t">
            {/* Continues the label bar's line across this column */}
            <div aria-hidden className="hidden h-11 border-b border-border lg:block" />
            <Reveal>
              <Accordion type="single" collapsible>
                {FAQ.map(({ question, answer }) => (
                  <AccordionItem
                    key={question}
                    value={question}
                    className="border-border px-6 md:px-8"
                  >
                    <AccordionTrigger className="py-5 text-[15px] font-medium hover:no-underline">
                      {question}
                    </AccordionTrigger>
                    <AccordionContent className="text-[15px] leading-relaxed text-muted-foreground">
                      {answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </Reveal>
          </div>
        </div>
      </section>
    </PublicShell>
  );
};

export default PricingPage;
