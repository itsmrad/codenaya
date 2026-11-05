"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { TEXT_INPUT, checkPointerEnabled, subscribePointer } from "./custom-cursor";

/**
 * The site's cursor, in its grid language: an orange dot inside four corner
 * marks, like the `[ ]` labels. Over anything clickable the marks glide out
 * and wrap the whole element in orange; in text fields it becomes a caret.
 */
type Mode = "idle" | "hover" | "input";

const INTERACTIVE =
  "button, a, [role='button'], [role='option'], [role='menuitem'], [data-clickable], .cursor-pointer, select, label, summary";
const TEXT = `${TEXT_INPUT}, textarea, [contenteditable='true'], .cm-content`;

/** The idle box around the pointer, and the gap brackets keep around a target. */
const IDLE = 22;
const PAD = 6;

const CORNERS = [
  "top-0 left-0 border-t border-l",
  "top-0 right-0 border-t border-r",
  "bottom-0 left-0 border-b border-l",
  "right-0 bottom-0 border-r border-b",
] as const;

export function BracketCursor() {
  const enabled = useSyncExternalStore(subscribePointer, checkPointerEnabled, () => false);
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [down, setDown] = useState(false);

  const dotRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<HTMLDivElement>(null);

  // Hide the native pointer only while ours is drawn.
  const drawn = enabled && visible;
  useEffect(() => {
    if (!drawn) return;
    document.documentElement.classList.add("custom-cursor-active");
    return () => document.documentElement.classList.remove("custom-cursor-active");
  }, [drawn]);

  useEffect(() => {
    if (!enabled) return;
    const mouse = { x: -200, y: -200 };
    // The follower's box: centre and size, eased toward its target each frame.
    const box = { x: -200, y: -200, w: IDLE, h: IDLE };
    let target: Element | null = null;
    let shown = false;
    let frame = 0;

    const loop = () => {
      // The brackets wrap the hovered element, else sit around the pointer.
      const rect = target ? target.getBoundingClientRect() : null;
      const goal = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width + PAD * 2, h: rect.height + PAD * 2 }
        : { x: mouse.x, y: mouse.y, w: IDLE, h: IDLE };
      const ease = rect ? 0.25 : 0.2;
      box.x += (goal.x - box.x) * ease;
      box.y += (goal.y - box.y) * ease;
      box.w += (goal.w - box.w) * ease;
      box.h += (goal.h - box.h) * ease;

      const settled =
        Math.abs(goal.x - box.x) < 0.1 && Math.abs(goal.y - box.y) < 0.1 && Math.abs(goal.w - box.w) < 0.1;
      if (settled) Object.assign(box, goal);

      if (dotRef.current) dotRef.current.style.transform = `translate3d(${mouse.x}px, ${mouse.y}px, 0)`;
      if (followRef.current) {
        followRef.current.style.transform = `translate3d(${box.x - box.w / 2}px, ${box.y - box.h / 2}px, 0)`;
        followRef.current.style.width = `${box.w}px`;
        followRef.current.style.height = `${box.h}px`;
      }
      // Keep running while hovering a target, so the box tracks it through scrolls.
      frame = settled && !rect ? 0 : requestAnimationFrame(loop);
    };
    const kick = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };

    const aimAt = (el: Element | null) => {
      const text = el?.closest(TEXT);
      target = text ? null : (el?.closest(INTERACTIVE) ?? null);
      setMode(text ? "input" : target ? "hover" : "idle");
      kick();
    };

    const onMove = (event: MouseEvent) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      if (!shown) {
        // Appear at the pointer, not where the box was last drawn.
        Object.assign(box, { x: mouse.x, y: mouse.y, w: IDLE, h: IDLE });
        shown = true;
        setVisible(true);
      }
      aimAt(event.target as Element | null);
    };
    // Scrolling moves the page under a still pointer.
    const onScroll = () => {
      if (shown) aimAt(document.elementFromPoint(mouse.x, mouse.y));
    };
    const onDown = () => setDown(true);
    const onUp = () => setDown(false);
    const hide = () => {
      shown = false;
      setVisible(false);
    };
    // No relatedTarget: the pointer left the window or went into an iframe.
    const onOut = (event: MouseEvent) => {
      if (!event.relatedTarget) hide();
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mousedown", onDown, { passive: true });
    window.addEventListener("mouseup", onUp, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", hide);
    document.addEventListener("mouseout", onOut);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("blur", hide);
      document.removeEventListener("mouseout", onOut);
      cancelAnimationFrame(frame);
    };
  }, [enabled]);

  if (!enabled) return null;

  const hover = mode === "hover";
  const input = mode === "input";

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[99999] overflow-hidden select-none"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 200ms ease" }}
    >
      {/* The brackets: a box eased toward the pointer or the hovered element. */}
      <div ref={followRef} className="fixed top-0 left-0 will-change-transform">
        {!input && (
          <div className={cn("absolute inset-0 transition-transform duration-150", down && "scale-90")}>
            {CORNERS.map((corner) => (
              <span
                key={corner}
                className={cn(
                  "absolute size-2 transition-colors duration-200",
                  corner,
                  hover ? "border-brand" : "border-foreground/60",
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* The dot, exactly at the pointer; a caret in text fields. */}
      <div ref={dotRef} className="fixed top-0 left-0 will-change-transform">
        {input ? (
          <span className="block h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 animate-cursor-blink bg-brand" />
        ) : (
          <span
            className={cn(
              "block size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand transition-transform duration-150",
              down && "scale-150",
            )}
          />
        )}
      </div>
    </div>
  );
}
