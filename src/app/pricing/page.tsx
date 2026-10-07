import type { Metadata } from "next";
import Link from "next/link";
import { Check, Minus } from "lucide-react";

import { AppNavbar } from "@/components/app-navbar";
import { LandingFooter } from "@/components/landing/footer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

const ComparisonValue = ({ value }: { value: string | boolean }) => {
  if (value === true) {
    return <Check aria-label="Included" className="size-4 text-brand" />;
  }
  if (value === false) {
    return <Minus aria-label="Not included" className="size-4 text-muted-foreground" />;
  }
  return <>{value}</>;
};

// Public: a static page, so signed-out visitors can see the plans.
const PricingPage = () => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-10 md:px-8 md:py-16">
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.25em] text-brand font-mono mb-4">
            Pricing
          </p>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tighter text-foreground">
            Start free. Bring your own key.
          </h1>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Use our credits, or run the agent on your own key with no limits. BYOK is free on
            every plan.
          </p>
        </div>

        {/* Plans */}
        <div className="mt-12 grid gap-6 md:grid-cols-2 max-w-4xl mx-auto">
          {PLAN_CARDS.map(({ plan, description, features }) => (
            <Card
              key={plan.id}
              data-testid={`plan-${plan.id}`}
              className={plan.id === "pro" ? "border-brand/60" : undefined}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  {plan.name}
                  {plan.id === "pro" && <Badge variant="secondary">Coming soon</Badge>}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold tracking-tight text-foreground">
                    ${plan.priceUsdPerMonth}
                  </span>
                  <span className="text-sm text-muted-foreground">/month</span>
                </p>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {formatCredits(plan.monthlyCredits)} credits a month
                </p>
                <ul className="mt-6 flex flex-col gap-2 text-sm text-muted-foreground">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                {plan.id === "free" ? (
                  <Button
                    asChild
                    className="w-full bg-brand text-brand-foreground hover:bg-brand/90"
                  >
                    <Link href={SIGN_UP_URL}>Get started</Link>
                  </Button>
                ) : (
                  // Checkout ships with billing (#105).
                  <Button className="w-full" variant="outline" disabled>
                    Coming soon
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Need more credits? Pro members can buy top-ups: {topUp}. Top-ups are for paid plans only.
        </p>

        {/* Comparison */}
        <section className="mt-20 max-w-4xl mx-auto">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Compare plans
          </h2>
          <Table className="mt-6">
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead>{free.name}</TableHead>
                <TableHead>{pro.name}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARISON.map((row) => (
                <TableRow key={row.feature}>
                  <TableCell className="whitespace-normal font-medium">{row.feature}</TableCell>
                  <TableCell className="whitespace-normal">
                    <ComparisonValue value={row.free} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <ComparisonValue value={row.pro} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        {/* FAQ */}
        <section className="mt-20 max-w-3xl mx-auto">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Frequently asked questions
          </h2>
          <Accordion type="single" collapsible className="mt-6">
            {FAQ.map(({ question, answer }) => (
              <AccordionItem key={question} value={question}>
                <AccordionTrigger>{question}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
};

export default PricingPage;
