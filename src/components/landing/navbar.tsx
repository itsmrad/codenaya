"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Menu, X } from "lucide-react";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export const LandingNavbar = () => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <>
      <motion.header
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
          scrolled
            ? "bg-background/80 backdrop-blur-xl border-b border-border/50 shadow-sm"
            : "bg-transparent"
        }`}
      >
        <nav className="max-w-7xl mx-auto px-6 md:px-8 h-16 flex items-center justify-between">
          {/* Logo + Brand */}
          <motion.a
            href="/"
            className="flex items-center gap-3 group"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <div className="relative">
              <img
                src="/logo-alt.svg"
                alt="Codenaya"
                className="size-7 dark:invert-0 invert transition-transform duration-300 group-hover:rotate-12"
              />
            </div>
            <span className="text-lg font-semibold tracking-tight text-foreground">
              codenaya
            </span>
          </motion.a>

          {/* Desktop Auth Buttons */}
          <div className="hidden md:flex items-center gap-3">
            <SignInButton mode="modal">
              <Button
                variant="ghost"
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Log in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Button className="text-sm font-medium bg-brand text-brand-foreground hover:bg-brand/90 rounded-full px-5 shadow-lg shadow-brand/20">
                  Sign Up
                </Button>
              </motion.div>
            </SignUpButton>
          </div>

          {/* Mobile Menu Toggle */}
          <button
            className="md:hidden p-2 text-foreground"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </nav>
      </motion.header>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-0 z-40 bg-background/98 backdrop-blur-xl pt-20 px-6 md:hidden"
          >
            <div className="flex flex-col gap-4 pt-8">
              <SignInButton mode="modal">
                <Button
                  variant="outline"
                  className="w-full h-12 text-base"
                  onClick={() => setMobileOpen(false)}
                >
                  Log in
                </Button>
              </SignInButton>
              <SignUpButton mode="modal">
                <Button
                  className="w-full h-12 text-base bg-brand text-brand-foreground hover:bg-brand/90"
                  onClick={() => setMobileOpen(false)}
                >
                  Sign Up
                </Button>
              </SignUpButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
