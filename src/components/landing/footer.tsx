"use client";

import { motion } from "motion/react";

export const LandingFooter = () => {
  return (
    <footer className="relative border-t border-border/40 py-12">
      <div className="max-w-7xl mx-auto px-6 md:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Brand */}
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="flex items-center gap-3"
          >
            <img
              src="/logo-alt.svg"
              alt="Codenaya"
              className="size-5 dark:invert-0 invert"
            />
            <span className="text-sm font-medium text-foreground">codenaya</span>
          </motion.div>

          {/* Links */}
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a
              href="https://github.com/itsmrad/codenaya"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              GitHub
            </a>
            <span className="text-border">·</span>
            <span className="text-muted-foreground/60">
              © {new Date().getFullYear()} Codenaya
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
};
