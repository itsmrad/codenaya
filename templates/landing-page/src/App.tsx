import { useState, type FormEvent } from "react";
import { Route, Routes } from "react-router-dom";
import { Check, ChevronDown, Gauge, Lock, Sparkles, Zap } from "lucide-react";

import { BRAND_NAME } from "./brand";
import { cn } from "./lib/utils";

const FEATURES = [
  { icon: Zap, title: "Fast by default", text: "Pages load in a blink, on any connection." },
  { icon: Lock, title: "Secure", text: "Encrypted at rest and in transit, with SSO for teams." },
  { icon: Gauge, title: "Insightful", text: "See what works with clear, real-time analytics." },
];

const PLANS = [
  { name: "Starter", monthly: 0, features: ["1 project", "Community support"] },
  { name: "Pro", monthly: 19, features: ["Unlimited projects", "Priority support", "Analytics"] },
  { name: "Team", monthly: 49, features: ["Everything in Pro", "SSO", "Audit log"] },
];

const FAQS = [
  { q: "Can I cancel any time?", a: "Yes. Plans renew monthly or yearly and you can cancel whenever you like." },
  { q: "Is there a free plan?", a: "Starter is free forever, with no card needed." },
  { q: "Do you offer refunds?", a: "We refund any payment within 14 days, no questions asked." },
];

function Pricing() {
  const [yearly, setYearly] = useState(false);
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-6 py-20">
      <h2 className="text-center text-3xl font-semibold tracking-tight">Pricing</h2>
      <div className="mt-6 flex justify-center gap-1 rounded-full bg-muted p-1 text-sm w-fit mx-auto">
        {[false, true].map((isYearly) => (
          <button
            key={String(isYearly)}
            type="button"
            onClick={() => setYearly(isYearly)}
            className={cn("rounded-full px-4 py-1.5", yearly === isYearly && "bg-background shadow-sm")}
          >
            {isYearly ? "Yearly (2 months free)" : "Monthly"}
          </button>
        ))}
      </div>
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {PLANS.map((plan, index) => (
          <div
            key={plan.name}
            className={cn("rounded-xl border bg-card p-6", index === 1 && "border-primary ring-2 ring-ring/40")}
          >
            <h3 className="font-semibold">{plan.name}</h3>
            <p className="mt-3 text-3xl font-semibold">
              ${yearly ? plan.monthly * 10 : plan.monthly}
              <span className="text-sm font-normal text-muted-foreground">/{yearly ? "year" : "month"}</span>
            </p>
            <ul className="mt-6 space-y-2 text-sm">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <Check className="size-4 text-primary" /> {feature}
                </li>
              ))}
            </ul>
            <a
              href="#signup"
              className="mt-6 block rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Choose {plan.name}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="mx-auto max-w-2xl px-6 py-20">
      <h2 className="text-center text-3xl font-semibold tracking-tight">Questions</h2>
      <div className="mt-8 divide-y rounded-xl border">
        {FAQS.map((item, index) => (
          <div key={item.q}>
            <button
              type="button"
              aria-expanded={open === index}
              onClick={() => setOpen(open === index ? null : index)}
              className="flex w-full items-center justify-between px-5 py-4 text-left font-medium"
            >
              {item.q}
              <ChevronDown className={cn("size-4 transition-transform", open === index && "rotate-180")} />
            </button>
            {open === index && <p className="px-5 pb-4 text-sm text-muted-foreground">{item.a}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function SignUp() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "invalid" | "done">("idle");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(/^\S+@\S+\.\S+$/.test(email) ? "done" : "invalid");
  };
  return (
    <section id="signup" className="bg-muted/50 px-6 py-20 text-center">
      <h2 className="text-3xl font-semibold tracking-tight">Get started with {BRAND_NAME}</h2>
      <p className="mt-2 text-muted-foreground">Join the newsletter for product news and tips.</p>
      {status === "done" ? (
        <p className="mt-6 font-medium text-primary">Thanks! Check your inbox.</p>
      ) : (
        <form onSubmit={submit} noValidate className="mx-auto mt-6 flex max-w-md flex-col gap-2 sm:flex-row">
          <label htmlFor="email" className="sr-only">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            aria-invalid={status === "invalid"}
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Sign up
          </button>
        </form>
      )}
      {status === "invalid" && <p className="mt-2 text-sm text-destructive">Enter a valid email address.</p>}
    </section>
  );
}

function Home() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-5 text-primary" /> {BRAND_NAME}
          </span>
          <div className="flex items-center gap-6 text-sm">
            <a href="#features" className="hidden text-muted-foreground hover:text-foreground sm:inline">Features</a>
            <a href="#pricing" className="hidden text-muted-foreground hover:text-foreground sm:inline">Pricing</a>
            <a href="#signup" className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground">Sign up</a>
          </div>
        </nav>
      </header>
      <main>
        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">Ship your best work with {BRAND_NAME}</h1>
          <p className="mt-6 text-lg text-muted-foreground">
            The all-in-one workspace that helps small teams plan, build and launch faster.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <a href="#signup" className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground">Start for free</a>
            <a href="#features" className="rounded-md border px-5 py-2.5 font-medium">See features</a>
          </div>
        </section>
        <section id="features" className="mx-auto grid max-w-5xl gap-6 px-6 py-12 md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border bg-card p-6">
              <Icon className="size-6 text-primary" />
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
        <Pricing />
        <Faq />
        <SignUp />
      </main>
      <footer className="border-t px-6 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
