"use client";

import { motion, useReducedMotion } from "motion/react";

import { AGENT_MODELS } from "@/features/conversations/agent-models";
import { cn } from "@/lib/utils";

/** The agent's model list, scrolling past under the hero. */
export const LandingModelMarquee = () => {
  const reduceMotion = useReducedMotion();
  // Two copies: sliding by half the track loops seamlessly.
  const track = [...AGENT_MODELS, ...AGENT_MODELS];

  return (
    <section aria-label="Supported models" className="grid border-b border-border md:grid-cols-[220px_1fr]">
      <p className="flex items-center border-b border-border px-6 py-4 font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground md:border-r md:border-b-0">
        Works with the models you already use
      </p>
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] motion-reduce:overflow-x-auto motion-reduce:[mask-image:none]">
        <motion.ul
          // Stopped by reduced motion: one row that scrolls sideways, without the loop's copy.
          className="flex w-max"
          animate={reduceMotion ? undefined : { x: ["0%", "-50%"] }}
          transition={{ duration: 45, ease: "linear", repeat: Infinity }}
        >
          {track.map((model, i) => (
            <li
              key={`${model.id}-${i}`}
              aria-hidden={i >= AGENT_MODELS.length}
              className={cn(
                "flex items-baseline gap-2 border-r border-border px-7 py-5 whitespace-nowrap",
                i >= AGENT_MODELS.length && "motion-reduce:hidden",
              )}
            >
              <span className="text-sm font-medium text-foreground">{model.label}</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                {model.provider}
              </span>
            </li>
          ))}
        </motion.ul>
      </div>
    </section>
  );
};
