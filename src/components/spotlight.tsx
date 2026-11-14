"use client";

import { useEffect } from "react";

/**
 * Feeds the cursor position to the `.spotlight` cell under it (globals.css),
 * so its glow follows the pointer. One listener for the whole app; cells only
 * need the class.
 */
export const SpotlightTracker = () => {
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const cell = (event.target as Element | null)?.closest?.<HTMLElement>(".spotlight");
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      cell.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
      cell.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, []);

  return null;
};
