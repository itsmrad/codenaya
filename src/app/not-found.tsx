import Link from "next/link";

import { LandingPromptComposer } from "@/components/landing/landing-prompt-composer";
import { MarketingNavbar } from "@/components/marketing-navbar";
import { NotFoundView } from "@/components/not-found-view";

const NEXT_STEPS = [
  { href: "/showcase", label: "Showcase" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
];

const NotFound = () => {
  return (
    <NotFoundView
      header={<MarketingNavbar />}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
    >
      {/* A stale link shouldn't be a dead end (#253): where to go, or start building. */}
      <nav aria-label="Suggested pages" className="flex items-center gap-5 text-sm">
        {NEXT_STEPS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="mt-6 w-full max-w-md space-y-3 text-left">
        <p className="text-center text-sm text-muted-foreground">Or start building something new</p>
        <LandingPromptComposer />
      </div>
    </NotFoundView>
  );
};

export default NotFound;
