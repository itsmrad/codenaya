"use client";

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";

interface Ripple {
  id: number;
  x: number;
  y: number;
}

// Inputs you type into; checkboxes, buttons, etc. count as interactive instead.
const TEXT_INPUT = `input:not(${["checkbox", "radio", "submit", "button", "range", "file", "color", "reset", "image"]
  .map((type) => `[type='${type}']`)
  .join(", ")})`;

type Mode = "down" | "hover" | "input" | "idle";

const RING_CLASS: Record<Mode, string> = {
  down: "size-9 border-2 border-brand bg-brand/20 opacity-95 animate-cursor-pulse shadow-[0_0_15px_color-mix(in_oklab,var(--brand)_50%,transparent)]",
  hover: "size-10 border-2 border-brand/80 bg-brand/10 opacity-90 animate-cursor-pulse shadow-[0_0_12px_color-mix(in_oklab,var(--brand)_30%,transparent)]",
  input: "h-7 w-2 rounded-xs border border-brand/60 bg-brand/15 opacity-80",
  idle: "size-7 border border-brand/50 bg-brand/5 opacity-60 animate-cursor-pulse",
};

const DOT_CLASS: Record<Mode, string> = {
  down: "size-3 animate-cursor-blink shadow-[0_0_16px_color-mix(in_oklab,var(--brand)_95%,transparent)]",
  hover: "size-2.5 shadow-[0_0_10px_color-mix(in_oklab,var(--brand)_80%,transparent)]",
  input: "h-4 w-1 rounded-full animate-cursor-blink shadow-[0_0_8px_color-mix(in_oklab,var(--brand)_80%,transparent)]",
  idle: "size-2 shadow-[0_0_8px_color-mix(in_oklab,var(--brand)_60%,transparent)]",
};

const checkPointerEnabled = () => {
  if (typeof window === "undefined") return false;
  const isFinePointer = window.matchMedia("(pointer: fine)").matches;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return isFinePointer && !prefersReducedMotion;
};

const subscribePointer = (callback: () => void) => {
  if (typeof window === "undefined") return () => {};
  const m1 = window.matchMedia("(pointer: fine)");
  const m2 = window.matchMedia("(prefers-reduced-motion: reduce)");
  m1.addEventListener("change", callback);
  m2.addEventListener("change", callback);
  return () => {
    m1.removeEventListener("change", callback);
    m2.removeEventListener("change", callback);
  };
};

export function CustomCursor() {
  const enabled = useSyncExternalStore(subscribePointer, checkPointerEnabled, () => false);
  const [visible, setVisible] = useState(false);
  const [isDown, setIsDown] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isInput, setIsInput] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  const visibleRef = useRef(false);
  const rippleTimeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const rippleId = useRef(0);

  // Current real mouse coordinates
  const mousePos = useRef({ x: -200, y: -200 });
  // Trailing follower coordinates
  const followerPos = useRef({ x: -200, y: -200 });

  // Separate positioning containers from animated visual elements
  // to avoid CSS keyframe animation transforms overriding translate3d
  const dotContainerRef = useRef<HTMLDivElement>(null);
  const ringContainerRef = useRef<HTMLDivElement>(null);

  // Cleanup pending ripple timeouts on unmount
  useEffect(() => {
    const timeouts = rippleTimeouts.current;
    return () => {
      timeouts.forEach((timer) => clearTimeout(timer));
      timeouts.clear();
    };
  }, []);

  const addRipple = useCallback((x: number, y: number) => {
    const id = ++rippleId.current;
    setRipples((prev) => [...prev.slice(-3), { id, x, y }]);
    const timer = setTimeout(() => {
      rippleTimeouts.current.delete(timer);
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 550);
    rippleTimeouts.current.add(timer);
  }, []);

  const showCursor = useCallback(() => {
    if (!visibleRef.current) {
      visibleRef.current = true;
      setVisible(true);
    }
  }, []);

  const hideCursor = useCallback(() => {
    if (visibleRef.current) {
      visibleRef.current = false;
      setVisible(false);
    }
  }, []);

  // Hide the native pointer only while the overlay is drawn, so there is
  // never two cursors and never none.
  const drawn = enabled && visible;
  useEffect(() => {
    if (!drawn) return;
    const root = document.documentElement;
    root.classList.add("custom-cursor-active");
    return () => root.classList.remove("custom-cursor-active");
  }, [drawn]);

  useEffect(() => {
    if (!enabled) return;

    // 0 while idle: the loop stops once the ring catches up with the mouse.
    let animId = 0;

    const onMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
      // Appearing: start the ring at the pointer, not where it was last drawn.
      if (!visibleRef.current) followerPos.current = { ...mousePos.current };
      showCursor();
      if (!animId) animId = requestAnimationFrame(loop);

      // Check if target is interactive or an input
      const target = e.target as HTMLElement | null;
      if (target) {
        const isInteractive = Boolean(
          target.closest(
            "button, a, [role='button'], [data-clickable], .cursor-pointer, select, [tabindex]:not([tabindex='-1'])"
          )
        );
        const isTextInput = Boolean(
          target.closest(`${TEXT_INPUT}, textarea, [contenteditable='true'], .cm-content`)
        );

        setIsHovering(isInteractive && !isTextInput);
        setIsInput(isTextInput);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      setIsDown(true);
      addRipple(e.clientX, e.clientY);
    };

    const onMouseUp = () => {
      setIsDown(false);
    };

    // No relatedTarget: the pointer left the window or went into an iframe,
    // where mousemove can't follow it.
    const onMouseOut = (e: MouseEvent) => {
      if (!e.relatedTarget) {
        hideCursor();
      }
    };

    const onMouseEnter = () => {
      showCursor();
    };

    const onBlur = () => {
      hideCursor();
    };

    // Smooth follower animation loop with lerp
    const loop = () => {
      const lerp = 0.22;
      followerPos.current.x += (mousePos.current.x - followerPos.current.x) * lerp;
      followerPos.current.y += (mousePos.current.y - followerPos.current.y) * lerp;

      // Converged: snap to the mouse and idle until the next mousemove.
      const settled =
        Math.abs(mousePos.current.x - followerPos.current.x) < 0.1 &&
        Math.abs(mousePos.current.y - followerPos.current.y) < 0.1;
      if (settled) followerPos.current = { ...mousePos.current };

      if (dotContainerRef.current) {
        dotContainerRef.current.style.transform = `translate3d(${mousePos.current.x}px, ${mousePos.current.y}px, 0)`;
      }
      if (ringContainerRef.current) {
        ringContainerRef.current.style.transform = `translate3d(${followerPos.current.x}px, ${followerPos.current.y}px, 0)`;
      }

      animId = settled ? 0 : requestAnimationFrame(loop);
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mousedown", onMouseDown, { passive: true });
    window.addEventListener("mouseup", onMouseUp, { passive: true });
    document.addEventListener("mouseout", onMouseOut);
    document.documentElement.addEventListener("mouseenter", onMouseEnter);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mouseout", onMouseOut);
      document.documentElement.removeEventListener("mouseenter", onMouseEnter);
      window.removeEventListener("blur", onBlur);
      cancelAnimationFrame(animId);
    };
  }, [enabled, addRipple, showCursor, hideCursor]);

  if (!enabled) return null;

  const mode: Mode = isDown ? "down" : isHovering ? "hover" : isInput ? "input" : "idle";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[99999] overflow-hidden select-none"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease" }}
    >
      {/* Click shockwave ripples */}
      {ripples.map((r) => (
        <div
          key={r.id}
          className="fixed top-0 left-0 pointer-events-none will-change-transform"
          style={{ transform: `translate3d(${r.x}px, ${r.y}px, 0)` }}
        >
          <span className="block -translate-x-1/2 -translate-y-1/2 size-8 rounded-full border-2 border-brand/80 animate-cursor-ripple" />
        </div>
      ))}

      {/* Outer Follower Ring */}
      <div
        ref={ringContainerRef}
        className="fixed top-0 left-0 pointer-events-none will-change-transform"
        style={{ transform: "translate3d(-200px, -200px, 0)" }}
      >
        <div
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,background-color,border-color,opacity] duration-200 ease-out ${RING_CLASS[mode]}`}
        />
      </div>

      {/* Inner Precision Orange Dot / Caret */}
      <div
        ref={dotContainerRef}
        className="fixed top-0 left-0 pointer-events-none will-change-transform"
        style={{ transform: "translate3d(-200px, -200px, 0)" }}
      >
        <div
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full bg-brand transition-[width,height,border-radius] duration-150 ${DOT_CLASS[mode]}`}
        />
      </div>
    </div>
  );
}
