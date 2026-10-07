import type { ReactNode } from "react";

import { AppNavbar } from "@/components/app-navbar";
import { LandingFooter } from "@/components/landing/footer";
import { CONTACT_EMAIL } from "@/lib/site";

type LegalPageProps = {
  title: string;
  lastUpdated: string;
  children: ReactNode;
};

/** Shared shell for the public legal pages (/terms, /privacy). */
export const LegalPage = ({ title, lastUpdated, children }: LegalPageProps) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-10 md:px-8 md:py-16">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tighter text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {lastUpdated}</p>
        <p
          role="note"
          className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
        >
          <strong>Template.</strong> This page is placeholder text pending legal review and is
          not yet a binding agreement.
        </p>
        <div className="mt-10 flex flex-col gap-8 text-sm md:text-base leading-relaxed text-muted-foreground [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
          {children}
        </div>
      </main>
      <LandingFooter />
    </div>
  );
};

/** The contact address, flagged as a template value until it is final. */
export const LegalContact = () => (
  <>
    <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> (placeholder address)
  </>
);
