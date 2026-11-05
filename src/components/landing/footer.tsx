"use client";

import Link from "next/link";
import { FaGithub } from "react-icons/fa";

import { GITHUB_REPO_URL, REPORT_ISSUE_URL } from "@/lib/site";
import { CodenayaLogo } from "@/components/codenaya-logo";

type FooterLink = { label: string; href: string };

// Only pages that exist are listed, so the footer never has dead links.
const FOOTER_COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Showcase", href: "/showcase" },
      { label: "Pricing", href: "/pricing" },
      { label: "Docs", href: "/docs" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "GitHub", href: GITHUB_REPO_URL },
      { label: "Changelog", href: `${GITHUB_REPO_URL}/releases` },
      { label: "Report an issue", href: REPORT_ISSUE_URL },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

const linkClassName = "hover:text-foreground transition-colors";

const FooterLinkItem = ({ label, href }: FooterLink) =>
  href.startsWith("/") ? (
    <Link href={href} className={linkClassName}>
      {label}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
      {label}
    </a>
  );

/** The footer, on the same framed grid as the page above it. */
export const LandingFooter = () => (
  <footer className="mx-auto w-full max-w-[1200px] border-x border-border">
    <div className="grid md:grid-cols-[1.4fr_repeat(3,1fr)]">
      <div className="flex flex-col gap-4 border-b border-border p-6 md:border-r md:border-b-0 md:p-8">
        <Link href="/" className="flex items-center gap-2.5">
          <CodenayaLogo size={22} />
          <span className="text-[15px] font-semibold tracking-tight text-foreground">codenaya</span>
        </Link>
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
          Build apps from your browser with an AI agent.
        </p>
      </div>
      {/* `contents` keeps the columns as cells of the grid above. */}
      <nav aria-label="Footer" className="contents">
        {FOOTER_COLUMNS.map((column) => (
          <div
            key={column.title}
            className="flex flex-col gap-4 border-border p-6 not-last:border-b md:p-8 md:not-last:border-r md:not-last:border-b-0"
          >
            <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{column.title}</h2>
            <ul className="flex flex-col gap-2.5 text-sm text-foreground/80">
              {column.links.map((link) => (
                <li key={link.label}>
                  <FooterLinkItem {...link} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>

    {/* The wordmark, cropped by the bottom edge */}
    <div aria-hidden className="overflow-hidden border-t border-border">
      <p className="translate-y-[18%] select-none text-center text-[clamp(4rem,19vw,15rem)] font-semibold leading-none tracking-[-0.06em] text-foreground/[0.05]">
        codenaya
      </p>
    </div>

    <div className="flex items-center justify-between gap-4 border-t border-border px-6 py-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground md:px-8">
      <span>© {new Date().getFullYear()} Codenaya</span>
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Codenaya on GitHub"
        className="transition-colors hover:text-foreground"
      >
        <FaGithub className="size-4" />
      </a>
    </div>
  </footer>
);
