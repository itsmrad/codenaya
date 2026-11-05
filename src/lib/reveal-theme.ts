import type { MouseEvent } from "react";
import { flushSync } from "react-dom";

/**
 * Runs a theme switch as a circle growing from the click, through the View
 * Transitions API. Browsers without it, and reduced motion, switch instantly.
 */
export const revealTheme = (event: MouseEvent, apply: () => void) => {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply();
    return;
  }
  const { clientX: x, clientY: y } = event;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(() => flushSync(apply));
  void transition.ready.then(() =>
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 550, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
    ),
  );
};
