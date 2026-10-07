"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SIGN_UP_URL } from "@/features/auth/constants";

export const LandingCTA = () => {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.4 });

  return (
    <section ref={sectionRef} className="relative py-14 md:py-20 overflow-hidden">
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
            <Button
              asChild
              size="lg"
              className="h-12 px-8 text-base font-medium bg-brand text-brand-foreground hover:bg-brand/90 rounded-full gap-2 group"
            >
              <Link href={SIGN_UP_URL}>
                Get Started Free
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
};
