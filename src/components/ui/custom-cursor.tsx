"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface Ripple {
  id: number;
  x: number;
  y: number;
}

export function CustomCursor() {
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [isDown, setIsDown] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [isInput, setIsInput] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // Current real mouse coordinates
  const mousePos = useRef({ x: -200, y: -200 });
  // Trailing follower coordinates
  const followerPos = useRef({ x: -200, y: -200 });

  // Separate positioning containers from animated visual elements
  // to avoid CSS keyframe animation transforms overriding translate3d
  const dotContainerRef = useRef<HTMLDivElement>(null);
  const ringContainerRef = useRef<HTMLDivElement>(null);

  // Check pointer capability (avoid rendering on touch screens / mobile)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isFinePointer = window.matchMedia("(pointer: fine)").matches;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setEnabled(isFinePointer && !prefersReducedMotion);
  }, []);

  const addRipple = useCallback((x: number, y: number) => {
    const id = Date.now() + Math.random();
    setRipples((prev) => [...prev.slice(-3), { id, x, y }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 600);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let animId: number;

    const onMouseMove = (e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
      if (!visible) setVisible(true);

      // Check if target is interactive or an input
      const target = e.target as HTMLElement | null;
      if (target) {
        const isInteractive = Boolean(
          target.closest(
            "button, a, [role='button'], [data-clickable], .cursor-pointer, select, [tabindex]:not([tabindex='-1'])"
          )
        );
        const isTextInput = Boolean(
          target.closest("input, textarea, [contenteditable='true'], .cm-content")
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

    const onMouseLeave = () => {
      setVisible(false);
    };

    const onMouseEnter = () => {
      setVisible(true);
    };

    // Smooth follower animation loop with lerp
    const loop = () => {
      const lerp = 0.22;
      followerPos.current.x += (mousePos.current.x - followerPos.current.x) * lerp;
      followerPos.current.y += (mousePos.current.y - followerPos.current.y) * lerp;

      if (dotContainerRef.current) {
        dotContainerRef.current.style.transform = `translate3d(${mousePos.current.x}px, ${mousePos.current.y}px, 0)`;
      }
      if (ringContainerRef.current) {
        ringContainerRef.current.style.transform = `translate3d(${followerPos.current.x}px, ${followerPos.current.y}px, 0)`;
      }

      animId = requestAnimationFrame(loop);
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mousedown", onMouseDown, { passive: true });
    window.addEventListener("mouseup", onMouseUp, { passive: true });
    document.addEventListener("mouseleave", onMouseLeave);
    document.addEventListener("mouseenter", onMouseEnter);

    animId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("mouseenter", onMouseEnter);
      cancelAnimationFrame(animId);
    };
  }, [enabled, visible, addRipple]);

  if (!enabled) return null;

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
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full transition-[width,height,background-color,border-color,opacity] duration-200 ease-out ${isDown
              ? "size-9 border-2 border-brand bg-brand/20 opacity-95 animate-cursor-pulse shadow-[0_0_15px_rgba(232,130,79,0.5)]"
              : isHovering
                ? "size-10 border-2 border-brand/80 bg-brand/10 opacity-90 animate-cursor-pulse shadow-[0_0_12px_rgba(232,130,79,0.3)]"
                : isInput
                  ? "h-7 w-2 rounded-xs border border-brand/60 bg-brand/15 opacity-80"
                  : "size-7 border border-brand/50 bg-brand/5 opacity-60"
            }`}
        />
      </div>

      {/* Inner Precision Orange Dot / Caret */}
      <div
        ref={dotContainerRef}
        className="fixed top-0 left-0 pointer-events-none will-change-transform"
        style={{ transform: "translate3d(-200px, -200px, 0)" }}
      >
        <div
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full bg-brand transition-[width,height,border-radius] duration-150 ${isDown
              ? "size-3 animate-cursor-blink shadow-[0_0_16px_rgba(232,130,79,0.95)]"
              : isHovering
                ? "size-2.5 shadow-[0_0_10px_rgba(232,130,79,0.8)]"
                : isInput
                  ? "h-4 w-1 rounded-full animate-cursor-blink shadow-[0_0_8px_rgba(232,130,79,0.8)]"
                  : "size-2 shadow-[0_0_8px_rgba(232,130,79,0.6)]"
            }`}
        />
      </div>
    </div>
  );
}
