"use client";

import type { ReactNode } from "react";
import { Check, EyeOff, KeyRound, Lock, Plug, ShieldCheck, Wallet, type LucideIcon } from "lucide-react";

import { Reveal } from "./reveal";
import { SectionHeader } from "./section-header";

type Point = { icon: LucideIcon; title: string; body: string; window: string; visual: ReactNode };

const POINTS: Point[] = [
  {
    icon: KeyRound,
    title: "Encrypted keys.",
    body: "Provider keys are sealed with envelope encryption before they are stored. You only ever see the last four characters.",
    window: "settings / ai-providers",
    visual: (
      <Row>
        <Lock className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-foreground">••••3f9a</span>
        <Status>sealed</Status>
      </Row>
    ),
  },
  {
    icon: EyeOff,
    title: "Secrets stay secret.",
    body: "Secret environment variables are encrypted, can't be revealed again and only reach the cloud sandbox.",
    window: "preview / env",
    visual: (
      <div className="flex flex-col gap-1.5 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-foreground">STRIPE_SECRET_KEY</span>
          <span className="text-muted-foreground">••••••</span>
          <Tag>secret</Tag>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-foreground">NEXT_PUBLIC_URL</span>
          <span className="truncate text-muted-foreground">https://…</span>
          <Tag muted>public</Tag>
        </div>
      </div>
    ),
  },
  {
    icon: ShieldCheck,
    title: "You approve actions.",
    body: "Before the agent changes or deletes data in a connected service, it asks you. Unanswered after 15 minutes, it's refused.",
    window: "chat",
    visual: (
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">stripe.create_price</span>
        <span className="flex gap-1.5 text-[11px]">
          <span className="rounded border border-border px-2 py-0.5 text-muted-foreground">Deny</span>
          <span className="rounded bg-brand px-2 py-0.5 font-medium text-brand-foreground">Approve</span>
        </span>
      </div>
    ),
  },
  {
    icon: Plug,
    title: "Access per project.",
    body: "Choose which projects can use each connected service, so a connection never reaches more than you allow.",
    window: "integrations / stripe",
    visual: (
      <div className="flex flex-col gap-1.5 text-[11px]">
        {[
          { name: "habit-tracker", on: true },
          { name: "storefront", on: false },
        ].map(({ name, on }) => (
          <div key={name} className="flex items-center justify-between font-mono">
            <span className="text-foreground">{name}</span>
            <span className={`flex h-3.5 w-6 items-center rounded-full px-0.5 ${on ? "justify-end bg-brand" : "bg-muted"}`}>
              <span className="size-2.5 rounded-full bg-card shadow-sm" />
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: Lock,
    title: "Private by default.",
    body: "Your projects stay private. Nothing reaches the Showcase until you choose Publish.",
    window: "project",
    visual: (
      <Row>
        <span className="truncate font-mono text-foreground">habit-tracker</span>
        <Tag muted>private</Tag>
        <span className="ml-auto rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Publish</span>
      </Row>
    ),
  },
  {
    icon: Wallet,
    title: "No surprise charges.",
    body: "If your own key stops working, the run stops. It never switches to your credits without asking.",
    window: "run",
    visual: (
      <Row>
        <span className="size-1.5 rounded-full bg-destructive" />
        <span className="truncate text-muted-foreground">Key rejected, run stopped</span>
        <span className="ml-auto font-mono text-[11px] text-foreground">0 credits</span>
      </Row>
    ),
  },
];

export const LandingTrust = () => (
  <section className="border-b border-border">
    <SectionHeader
      index={4}
      label="In control"
      title="Your code, your keys,"
      accent="your call"
      description="Codenaya is built so you never have to trust it with more than it needs."
    />
    <ul className="grid border-t border-border sm:grid-cols-2 lg:grid-cols-3">
      {POINTS.map(({ icon: Icon, title, body, window, visual }, i) => (
        <li
          key={title}
          className="spotlight group flex flex-col border-border max-sm:not-last:border-b sm:max-lg:odd:border-r sm:max-lg:[&:nth-last-child(n+3)]:border-b lg:[&:not(:nth-child(3n))]:border-r lg:[&:nth-last-child(n+4)]:border-b"
        >
          <Reveal delay={(i % 3) * 0.08} className="flex flex-1 flex-col">
            <div className="flex h-36 items-center justify-center border-b border-border bg-muted/30 p-6 transition-colors group-hover:bg-muted/50">
              {/* A small window, like the feature cells above */}
              <div className="w-full max-w-xs overflow-hidden rounded-md border border-border bg-card shadow-sm">
                <div className="flex h-6 items-center gap-1 border-b border-border px-2">
                  {[0, 1, 2].map((dot) => (
                    <span key={dot} className="size-1.5 rounded-full bg-muted-foreground/25" />
                  ))}
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">{window}</span>
                </div>
                <div className="px-3 py-2.5 text-[12px]">{visual}</div>
              </div>
            </div>
            <div className="flex flex-col gap-3 p-6 md:p-8">
              <Icon strokeWidth={1.5} className="size-5 text-muted-foreground" />
              <p className="text-sm leading-relaxed text-muted-foreground">
                <strong className="font-semibold text-foreground">{title}</strong> {body}
              </p>
            </div>
          </Reveal>
        </li>
      ))}
    </ul>
  </section>
);

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>;
}

function Tag({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <span
      className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] ${muted ? "bg-muted text-muted-foreground" : "bg-brand/15 text-brand-text"}`}
    >
      {children}
    </span>
  );
}

function Status({ children }: { children: string }) {
  return (
    <span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-emerald-600">
      <Check className="size-3" /> {children}
    </span>
  );
}
