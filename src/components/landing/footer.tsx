"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { FaGithub } from "react-icons/fa";

import { GITHUB_REPO_URL, REPORT_ISSUE_URL } from "@/lib/site";

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

export const LandingFooter = () => {
  return (
    <footer className="relative border-t border-border/40 py-12">
      <div className="max-w-7xl mx-auto px-6 md:px-8">
        <div className="flex flex-col md:flex-row md:justify-between gap-10">
          {/* Brand */}
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="flex flex-col gap-3 max-w-xs"
          >
            <Link href="/" className="flex items-center gap-3">
              <img
                src="/logo-alt.svg"
                alt="Codenaya"
                className="size-5 dark:invert-0 invert"
              />
              <span className="text-sm font-medium text-foreground">codenaya</span>
            </Link>
            <p className="text-sm text-muted-foreground">
              Build apps from your browser with an AI agent.
            </p>
          </motion.div>

          {/* Link columns */}
          <nav
            aria-label="Footer"
            className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-16"
          >
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.title} className="flex flex-col gap-3">
                <h2 className="text-xs font-medium uppercase tracking-[0.15em] text-foreground">
                  {column.title}
                </h2>
                <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
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

        {/* Bottom bar */}
        <div className="mt-10 pt-6 border-t border-border/40 flex items-center justify-between gap-4 text-sm text-muted-foreground/60">
          <span>© {new Date().getFullYear()} Codenaya</span>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Codenaya on GitHub"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <FaGithub className="size-4" />
          </a>
        </div>
      </div>
    </footer>
  );
};
