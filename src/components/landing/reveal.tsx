"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Fades and lifts its children in the first time they scroll into view. */
export const Reveal = ({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) => {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.6, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
};

/** Counts up from 0 the first time it scrolls into view. */
export const CountUp = ({ to }: { to: number }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!inView || !ref.current) return;
    const node = ref.current;
    if (reduceMotion) {
      node.textContent = to.toLocaleString("en-US");
      return;
    }
    const controls = animate(0, to, {
      duration: 1.2,
      ease: EASE,
      onUpdate: (v) => (node.textContent = Math.round(v).toLocaleString("en-US")),
    });
    return () => controls.stop();
  }, [inView, reduceMotion, to]);

  return <span ref={ref}>{to.toLocaleString("en-US")}</span>;
};
