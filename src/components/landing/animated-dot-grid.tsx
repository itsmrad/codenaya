"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

interface AnimatedDotGridProps {
  className?: string;
  /** Grid column and row spacing in pixels. Defaults to 26px. */
  spacing?: number;
}

interface Stream {
  col: number;
  y: number;
  speed: number;
  length: number;
  isAmber: boolean;
}

const checkPrefersReducedMotion = () => {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

const subscribeReducedMotion = (callback: () => void) => {
  if (typeof window === "undefined") return () => {};
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", callback);
  return () => {
    mediaQuery.removeEventListener("change", callback);
  };
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return [isNaN(r) ? 232 : r, isNaN(g) ? 130 : g, isNaN(b) ? 79 : b];
  }
  if (clean.length >= 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return [isNaN(r) ? 232 : r, isNaN(g) ? 130 : g, isNaN(b) ? 79 : b];
  }
  return [232, 130, 79];
}

/**
 * Superteam-inspired Dot Matrix Animation (Dark Mode Only).
 * Vertical streams of light glide down the grid columns with glowing heads and fading tails,
 * accompanied by interactive cursor glow and warm amber accents.
 *
 * Implements performance, accessibility, and lifecycle requirements from Issue #417.
 */
export const AnimatedDotGrid = ({
  className,
  spacing = 26,
}: AnimatedDotGridProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const prefersReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    checkPrefersReducedMotion,
    () => false,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // Only run in dark mode
    if (resolvedTheme !== "dark") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let animationFrameId: number | null = null;
    let isIntersecting = false;
    let isTabVisible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
    let width = 0;
    let height = 0;
    const streams: Stream[] = [];
    let lastTime = performance.now();

    // Read --brand token dynamically (Issue #417)
    let brandRgb = [232, 130, 79];
    const updateBrandColor = () => {
      try {
        const rawBrand = getComputedStyle(canvas).getPropertyValue("--brand").trim();
        if (rawBrand) {
          brandRgb = hexToRgb(rawBrand);
        }
      } catch {
        brandRgb = [232, 130, 79];
      }
    };
    updateBrandColor();

    // Interactive mouse coordinates
    let mouseX = -1000;
    let mouseY = -1000;

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    };

    const onMouseLeave = () => {
      mouseX = -1000;
      mouseY = -1000;
    };

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseleave", onMouseLeave, { passive: true });

    // Stream initialization: preserve existing streams across resizes (Issue #417)
    const updateStreamsForSize = (numCols: number, canvasHeight: number) => {
      const targetCount = Math.max(12, Math.floor(numCols * 0.38));
      if (streams.length === 0) {
        for (let i = 0; i < targetCount; i++) {
          streams.push({
            col: Math.floor(Math.random() * numCols),
            y: Math.random() * canvasHeight,
            speed: 60 + Math.random() * 90,
            length: (4 + Math.floor(Math.random() * 6)) * spacing,
            isAmber: Math.random() < 0.28,
          });
        }
      } else {
        // Clamp existing streams to current column bounds
        for (const s of streams) {
          if (s.col >= numCols) {
            s.col = Math.floor(Math.random() * numCols);
          }
        }
        while (streams.length < targetCount) {
          streams.push({
            col: Math.floor(Math.random() * numCols),
            y: Math.random() * canvasHeight,
            speed: 60 + Math.random() * 90,
            length: (4 + Math.floor(Math.random() * 6)) * spacing,
            isAmber: Math.random() < 0.28,
          });
        }
        if (streams.length > targetCount) {
          streams.length = targetCount;
        }
      }
    };

    const drawStaticGrid = () => {
      if (width === 0 || height === 0) return;
      ctx.clearRect(0, 0, width, height);
      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;

      ctx.fillStyle = "rgba(240, 236, 230, 0.12)";
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.beginPath();
          ctx.arc(c * spacing, r * spacing, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    // Safe resize handler: does NOT retry recursively if size is 0 (Issue #417)
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || canvas.offsetWidth || canvas.parentElement?.clientWidth || 0;
      const h = rect.height || canvas.offsetHeight || canvas.parentElement?.clientHeight || 0;

      if (w === 0 || h === 0) {
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = w;
      height = h;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const numCols = Math.ceil(width / spacing) + 1;
      updateStreamsForSize(numCols, height);
      updateBrandColor();

      if (prefersReducedMotion) {
        drawStaticGrid();
      }
    };

    resize();

    // Render loop and control
    const stopLoop = () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const render = (now: number) => {
      // Acceptance criteria: stop RAF loop immediately when offscreen/hidden
      if (!isIntersecting || !isTabVisible || prefersReducedMotion) {
        animationFrameId = null;
        return;
      }

      if (width === 0 || height === 0) {
        resize();
        if (width === 0 || height === 0) {
          animationFrameId = null;
          return;
        }
      }

      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      ctx.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;

      // Update stream positions
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i];
        s.y += s.speed * dt;
        if (s.y - s.length > height) {
          s.y = -Math.random() * 100;
          s.col = Math.floor(Math.random() * cols);
          s.speed = 60 + Math.random() * 90;
          s.length = (4 + Math.floor(Math.random() * 6)) * spacing;
          s.isAmber = Math.random() < 0.28;
        }
      }

      // Group streams by column preserving all streams per column
      const streamsByCol = new Map<number, Stream[]>();
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i];
        const existing = streamsByCol.get(s.col);
        if (existing) {
          existing.push(s);
        } else {
          streamsByCol.set(s.col, [s]);
        }
      }

      const [brR, brG, brB] = brandRgb;

      // Render grid points
      for (let c = 0; c < cols; c++) {
        const x = c * spacing;
        const colStreams = streamsByCol.get(c);

        for (let r = 0; r < rows; r++) {
          const y = r * spacing;

          let alpha = 0.12;
          let radius = 1.2;
          let isAccent = (c * 17 + r * 23) % 19 === 0;
          let isHead = false;

          if (colStreams && colStreams.length > 0) {
            for (let si = 0; si < colStreams.length; si++) {
              const colStream = colStreams[si];
              const headY = colStream.y;
              const distBehindHead = headY - y;

              if (distBehindHead >= -spacing * 0.5 && distBehindHead <= colStream.length) {
                if (distBehindHead < spacing * 0.8) {
                  isHead = true;
                  alpha = 0.95;
                  radius = 2.4;
                  if (colStream.isAmber) isAccent = true;
                } else {
                  const progress = 1 - distBehindHead / colStream.length;
                  alpha = Math.max(alpha, 0.12 + progress * 0.65);
                  radius = Math.max(radius, 1.2 + progress * 1.0);
                  if (colStream.isAmber && progress > 0.3) isAccent = true;
                }
              }
            }
          }

          // Mouse proximity illumination
          const dx = x - mouseX;
          const dy = y - mouseY;
          const mouseDist = Math.sqrt(dx * dx + dy * dy);
          if (mouseDist < 120) {
            const mouseEffect = Math.pow(1 - mouseDist / 120, 2);
            alpha = Math.min(1, alpha + mouseEffect * 0.6);
            radius = Math.max(radius, 1.2 + mouseEffect * 1.4);
          }

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);

          if (isHead) {
            ctx.fillStyle = isAccent
              ? `rgba(${brR}, ${brG}, ${brB}, ${alpha})`
              : `rgba(255, 255, 255, ${alpha})`;
          } else if (isAccent) {
            ctx.fillStyle = `rgba(${brR}, ${brG}, ${brB}, ${alpha})`;
          } else {
            ctx.fillStyle = `rgba(240, 236, 230, ${alpha})`;
          }
          ctx.fill();
        }
      }

      // Only schedule next frame if still active
      animationFrameId = requestAnimationFrame(render);
    };

    const maybeStartLoop = () => {
      if (prefersReducedMotion) {
        stopLoop();
        drawStaticGrid();
        return;
      }
      if (isIntersecting && isTabVisible && animationFrameId === null) {
        lastTime = performance.now();
        animationFrameId = requestAnimationFrame(render);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      maybeStartLoop();
    });
    resizeObserver.observe(canvas);

    // Strictly separate IntersectionObserver and visibilitychange flags (Issue #417)
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        isIntersecting = entry.isIntersecting;
        if (isIntersecting) {
          maybeStartLoop();
        } else {
          stopLoop();
        }
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    const handleVisibilityChange = () => {
      isTabVisible = document.visibilityState === "visible";
      if (isTabVisible) {
        maybeStartLoop();
      } else {
        stopLoop();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Initial state check
    if (prefersReducedMotion) {
      drawStaticGrid();
    } else {
      maybeStartLoop();
    }

    return () => {
      stopLoop();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [resolvedTheme, spacing, prefersReducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={
        "pointer-events-none absolute inset-0 size-full transition-opacity duration-300 " +
        (resolvedTheme === "dark" ? "opacity-100" : "opacity-0 pointer-events-none") +
        (className ? ` ${className}` : "")
      }
    />
  );
};
