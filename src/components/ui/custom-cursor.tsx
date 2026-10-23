"use client";

import { useEffect, useRef, useState } from "react";

export function CustomCursor() {
  const [visible, setVisible] = useState(false);
  const [isDown, setIsDown] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: -100, y: -100 });
  const ring = useRef({ x: -100, y: -100 });

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let id: number;

    const onMove = (e: MouseEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
      if (!visible) setVisible(true);

      const target = e.target as HTMLElement | null;
      setIsHovering(Boolean(target?.closest("button, a, [role='button'], .cursor-pointer, select")));
    };

    const loop = () => {
      ring.current.x += (mouse.current.x - ring.current.x) * 0.25;
      ring.current.y += (mouse.current.y - ring.current.y) * 0.25;

      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${mouse.current.x}px, ${mouse.current.y}px, 0)`;
      }
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${ring.current.x}px, ${ring.current.y}px, 0)`;
      }

      id = requestAnimationFrame(loop);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mousedown", () => setIsDown(true), { passive: true });
    window.addEventListener("mouseup", () => setIsDown(false), { passive: true });
    id = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(id);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[99999] overflow-hidden select-none">
      {/* Follower ring */}
      <div ref={ringRef} className="fixed top-0 left-0 will-change-transform">
        <div
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/60 transition-[width,height,opacity] duration-150 ${
            isDown ? "size-9 bg-brand/20 opacity-100" : isHovering ? "size-9 bg-brand/10 opacity-90" : "size-6 bg-brand/5 opacity-50"
          }`}
        />
      </div>

      {/* Orange dot cursor */}
      <div ref={dotRef} className="fixed top-0 left-0 will-change-transform">
        <div
          className={`-translate-x-1/2 -translate-y-1/2 rounded-full bg-brand transition-all duration-100 ${
            isDown ? "size-3 animate-[cursor-blink_400ms_infinite] shadow-[0_0_12px_var(--color-brand)]" : isHovering ? "size-2.5 shadow-[0_0_8px_var(--color-brand)]" : "size-2 shadow-[0_0_6px_var(--color-brand)]"
          }`}
        />
      </div>
    </div>
  );
}
