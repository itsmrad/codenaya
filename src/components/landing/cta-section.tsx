"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { ArrowRight } from "lucide-react";
import { SignUpButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export const LandingCTA = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.4 });

  return (
    <section ref={sectionRef} className="relative py-32 md:py-40 overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_50%,rgba(232,130,79,0.06),transparent_60%)] dark:bg-[radial-gradient(ellipse_80%_60%_at_50%_50%,rgba(232,130,79,0.1),transparent_60%)]" />

      <div className="relative z-10 max-w-3xl mx-auto px-6 md:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-8"
        >
          <h2 className="text-4xl md:text-6xl font-bold tracking-tighter text-foreground">
            Ready to build?
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Join developers who are shipping faster with AI-powered coding.
            No setup required — start building in seconds.
          </p>
          <div className="pt-4">
            <SignUpButton mode="modal">
              <motion.div
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                className="inline-block"
              >
                <Button
                  size="lg"
                  className="h-14 px-10 text-base font-medium bg-brand text-white hover:bg-brand/90 rounded-full shadow-2xl shadow-brand/30 gap-2 group"
                >
                  Get Started Free
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Button>
              </motion.div>
            </SignUpButton>
          </div>
        </motion.div>
      </div>
    </section>
  );
};
