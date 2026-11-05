import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ArrowRight, FolderGit2, KeyRound, MonitorPlay, Sparkles } from "lucide-react";

import { PublicShell } from "@/components/landing/public-shell";
import { Reveal } from "@/components/landing/reveal";
import { SectionHeader } from "@/components/landing/section-header";
import { PROSE_CLASS_NAME } from "@/components/legal-page";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { formatCredits, PLANS } from "@/features/billing/plans";
import { PUBLIC_KEY_PREFIXES } from "@/features/integrations/env-keys";
import { AI_PROVIDERS_SETTINGS_URL, SKILLS_SETTINGS_URL } from "@/features/settings/nav";
import { REPORT_ISSUE_URL } from "@/lib/site";
import { SHORTCUTS, SHORTCUT_SCOPES, formatShortcutKey } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

import { DocsNav } from "./docs-nav";

export const metadata: Metadata = {
  title: "Docs — Codenaya",
  description:
    "How to build with Codenaya: prompting, the live preview, GitHub, integrations, environment variables, your own AI keys, skills and shortcuts.",
};

const { free, pro } = PLANS;

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
    <Reveal className="flex flex-col gap-3">
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </Reveal>
  </section>
);

/** The most-read topics, as cards above the full docs. Not headings, so the section titles stay unique. */
const QUICK_START = [
  { id: "getting-started", icon: Sparkles, label: "Getting started", body: "Describe an app and watch the agent build it." },
  { id: "preview", icon: MonitorPlay, label: "Live preview", body: "Run your app in a cloud sandbox with a terminal." },
  { id: "github", icon: FolderGit2, label: "GitHub & ZIP", body: "Import a repo, export a new one, or download a ZIP." },
  { id: "byok", icon: KeyRound, label: "Your own key", body: "Unlimited runs on your OpenRouter, OpenAI or Anthropic key." },
];

const SECTIONS: { id: string; title: string; content: ReactNode }[] = [
  {
    id: "getting-started",
    title: "Getting started",
    content: (
      <>
        <p>
          Codenaya is a browser IDE with an AI agent. Describe the app you want and the agent
          writes the code, runs it in a sandbox and shows you a live preview.
        </p>
        <ul>
          <li>
            Sign in, then type what you want to build into <strong>What will you build?</strong>{" "}
            on the dashboard. A new project opens with the agent already working.
          </li>
          <li>
            Keep chatting to change things. The <strong>Code</strong> tab shows every file, and you
            can edit them yourself at any time.
          </li>
          <li>
            The <strong>Preview</strong> tab runs your app. Open it in a new tab or switch device
            sizes from its toolbar.
          </li>
          <li>
            Use <strong>Publish</strong> in the project bar to share your project on the{" "}
            <Link href="/showcase">Showcase</Link>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "prompting",
    title: "Prompting tips",
    content: (
      <ul>
        <li>Start with the goal and the main screens, then add details in follow-up messages.</li>
        <li>Name the stack if you care about it, e.g. &ldquo;React + Vite with Tailwind&rdquo;.</li>
        <li>
          Ask for one change at a time. Small, specific requests are faster, cheaper and easier
          to review.
        </li>
        <li>
          Attach a screenshot or mockup to show what you mean, and paste error messages as they
          appear.
        </li>
        <li>Use the enhance button in the composer to turn a rough idea into a detailed prompt.</li>
        <li>
          Type <code>/</code> to apply one of your <a href="#skills">skills</a> to a message.
        </li>
      </ul>
    ),
  },
  {
    id: "preview",
    title: "Preview & sandbox",
    content: (
      <>
        <p>The preview can run your app on one of two engines, picked in its toolbar:</p>
        <ul>
          <li>
            <strong>Sandbox</strong> (default): a cloud sandbox with a full Node environment and
            terminal. It gets all your environment variables, including secrets.
          </li>
          <li>
            <strong>WebContainer</strong>: runs in your browser tab and starts quickly. Secret
            variables are withheld because anything in the page is visible to its user.
          </li>
        </ul>
        <p>
          Preview settings let you change the install and start commands when your project does
          not use the defaults. If the preview fails to start, check the terminal output below it
          and ask the agent to fix the error.
        </p>
      </>
    ),
  },
  {
    id: "github",
    title: "GitHub import & export, ZIP",
    content: (
      <ul>
        <li>
          <strong>Import</strong>: choose Import from GitHub on the dashboard to start a project
          from an existing repository. Link your GitHub account when asked.
        </li>
        <li>
          <strong>Export</strong>: the Export menu in the project bar creates a new private or
          public GitHub repository with your code.
        </li>
        <li>
          <strong>ZIP</strong>: download every file as a ZIP from the same Export menu.
        </li>
      </ul>
    ),
  },
  {
    id: "integrations",
    title: "Integrations & approvals",
    content: (
      <>
        <p>
          Integrations give the agent access to services such as Supabase, Neon, Stripe, GitHub,
          Sentry, Cloudflare and Linear. Connect them from <strong>Integrations</strong> in the
          project bar or in Settings, and choose which projects can use each connection.
        </p>
        <p>
          Before the agent runs an action that changes or deletes data in a connected service, it
          asks you in the chat. Approve or deny it there; if nobody answers within 15 minutes the
          action is refused.
        </p>
      </>
    ),
  },
  {
    id: "env-vars",
    title: "Environment variables",
    content: (
      <>
        <p>
          Add environment variables from the preview toolbar. Each one is either public or secret:
        </p>
        <ul>
          <li>
            <strong>Secret</strong> values are encrypted, can&rsquo;t be revealed again and only
            reach the cloud sandbox.
          </li>
          <li>
            <strong>Public</strong> values are visible in the browser. Keys starting with{" "}
            {PUBLIC_KEY_PREFIXES.map((prefix, index) => (
              <span key={prefix}>
                {index > 0 && ", "}
                <code>{prefix}</code>
              </span>
            ))}{" "}
            are always public, because frameworks embed them in the client bundle.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "byok",
    title: "Bring your own key (BYOK)",
    content: (
      <p>
        Add an OpenRouter, OpenAI or Anthropic key, or any OpenAI-compatible endpoint, in{" "}
        <Link href={AI_PROVIDERS_SETTINGS_URL}>Settings &rsaquo; AI providers</Link> and pick a
        default model. Agent runs, editor suggestions and quick edits then use your key: no
        credits, no daily limit, and you pay your provider directly. Keys are encrypted at rest.
        If a key stops working, the run stops with an error instead of switching to your credits.
      </p>
    ),
  },
  {
    id: "skills",
    title: "Skills",
    content: (
      <p>
        Skills are reusable instructions for the agent, written as a <code>SKILL.md</code>. Create
        or import them (from a GitHub folder or skills.sh) in{" "}
        <Link href={SKILLS_SETTINGS_URL}>Settings &rsaquo; Skills</Link>, and turn them on per
        project from <strong>Skills</strong> in the project bar. In the chat, type <code>/</code>{" "}
        and a skill name to apply it to that message.
      </p>
    ),
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    content: (
      <>
        <p>
          Press <Kbd>?</Kbd> in the app to see these at any time. On a Mac, use <Kbd>⌘</Kbd>{" "}
          instead of <Kbd>Ctrl</Kbd>.
        </p>
        {SHORTCUT_SCOPES.map((scope) => (
          <div key={scope}>
            <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide">{scope}</h3>
            <ul className="list-none! pl-0! space-y-0! divide-y divide-border/60">
              {SHORTCUTS.filter((shortcut) => shortcut.scope === scope).map((shortcut) => (
                <li
                  key={shortcut.label}
                  className="flex items-center justify-between gap-4 py-2 text-sm text-foreground"
                >
                  <span>{shortcut.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {shortcut.keys.map((combo, index) => (
                      <span key={combo.join("+")} className="flex items-center gap-1.5">
                        {index > 0 && <span>or</span>}
                        <KbdGroup>
                          {combo.map((key) => (
                            <Kbd key={key}>{formatShortcutKey(key, false)}</Kbd>
                          ))}
                        </KbdGroup>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </>
    ),
  },
  {
    id: "faq",
    title: "Pricing & credits FAQ",
    content: (
      <>
        <p>
          <strong>What is a credit?</strong> One credit is $0.01 of AI usage. A run costs credits
          based on the model and how much work it does.
        </p>
        <p>
          <strong>How many do I get?</strong> {free.name} includes{" "}
          {formatCredits(free.monthlyCredits)} credits a month (up to{" "}
          {formatCredits(free.dailyCreditCap ?? 0)} a day). {pro.name} includes{" "}
          {formatCredits(pro.monthlyCredits)} a month with no daily cap. See{" "}
          <Link href="/pricing">Pricing</Link>.
        </p>
        <p>
          <strong>Do runs on my own key use credits?</strong> No. Runs on your own key are
          unlimited on every plan.
        </p>
        <p>
          <strong>Found a bug?</strong>{" "}
          <a href={REPORT_ISSUE_URL} target="_blank" rel="noopener noreferrer">
            Report an issue on GitHub
          </a>
          .
        </p>
      </>
    ),
  },
];

// Public: one page with anchors, so every topic is a link away from the Help menu.
const DocsPage = () => {
  return (
    <PublicShell>
      <section className="border-b border-border">
        <SectionHeader
          as="h1"
          label="Docs"
          title="Docs"
          description="Everything you need to build, preview and ship with Codenaya."
        />
        <div className="grid grid-cols-1 border-t border-border sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_START.map(({ id, icon: Icon, label, body }, i) => (
            <Reveal
              key={id}
              delay={i * 0.08}
              className="spotlight border-border max-sm:not-last:border-b sm:max-lg:odd:border-r sm:max-lg:[&:nth-child(-n+2)]:border-b lg:not-last:border-r"
            >
              <a
                href={`#${id}`}
                className="group flex h-full flex-col gap-3 p-6 transition-colors hover:bg-brand/[0.04] md:p-8"
              >
                <span className="flex items-center justify-between">
                  <Icon
                    strokeWidth={1.5}
                    className="size-6 text-brand transition-transform duration-300 group-hover:-translate-y-0.5"
                  />
                  <span aria-hidden className="font-mono text-[10px] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </span>
                <span className="font-semibold text-foreground">{label}</span>
                <span className="text-sm leading-relaxed text-muted-foreground">{body}</span>
                <ArrowRight className="mt-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
              </a>
            </Reveal>
          ))}
        </div>
      </section>

      <div className="grid border-b border-border md:grid-cols-[15rem_1fr]">
        <div className="border-border p-6 max-md:border-b md:border-r md:p-8">
          <DocsNav sections={SECTIONS.map(({ id, title }) => ({ id, title }))} />
        </div>
        <div
          className={cn(
            "min-w-0 px-6 py-10 md:px-12 md:py-14 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.9em] [&_code]:text-foreground [&_h2]:text-2xl! [&_h2]:tracking-[-0.02em]",
            PROSE_CLASS_NAME,
          )}
        >
          {SECTIONS.map(({ id, title, content }) => (
            <Section key={id} id={id} title={title}>
              {content}
            </Section>
          ))}
        </div>
      </div>
    </PublicShell>
  );
};

export default DocsPage;
