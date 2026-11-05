"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const GLYPH_CHARS = [
  "{",
  "}",
  "<",
  ">",
  "/",
  ";",
  "=",
  "(",
  ")",
  "[",
  "]",
  "=>",
  "$",
  "#",
  "&",
  "|",
  "!",
  "*",
];

interface Particle {
  char: string;
  z: number;
  size: number;
  baseOpacity: number;
  speed: number;
  xRatio: number;
  y: number;
}

const spawnParticle = (p: Particle, initialSpawn: boolean) => {
  p.char = GLYPH_CHARS[Math.floor(Math.random() * GLYPH_CHARS.length)];
  p.z = Math.random();
  p.size = 14 + p.z * 30;
  p.baseOpacity = 0.15 + p.z * 0.55;
  p.speed = (0.5 + p.z * 1.5) * (0.012 + Math.random() * (0.042 - 0.012));

  const isLeft = Math.random() < 0.5;
  p.xRatio = isLeft ? Math.random() * 0.25 : 0.75 + Math.random() * 0.25;

  if (initialSpawn) {
    p.y = Math.random() * 1.05;
  } else {
    p.y = 1.05;
  }
};

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export const SideGlyphs = () => {
  const mounted = useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = window.innerWidth;
    let height = window.innerHeight;

    let emberR = 255;
    let emberG = 95;
    let emberB = 58;
    let isDarkTheme = true;
    let monoFont = "'IBM Plex Mono', ui-monospace, monospace";

    const updateThemeAndFont = () => {
      const root = document.documentElement;
      isDarkTheme =
        root.classList.contains("dark") ||
        (!root.classList.contains("light") &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);

      const rawEmber = getComputedStyle(root).getPropertyValue("--ember").trim();
      if (rawEmber.startsWith("#")) {
        const hex = rawEmber.slice(1);
        if (hex.length === 6) {
          emberR = parseInt(hex.substring(0, 2), 16);
          emberG = parseInt(hex.substring(2, 4), 16);
          emberB = parseInt(hex.substring(4, 6), 16);
        }
      } else if (rawEmber.startsWith("rgb")) {
        const parts = rawEmber.match(/\d+/g);
        if (parts && parts.length >= 3) {
          emberR = parseInt(parts[0], 10);
          emberG = parseInt(parts[1], 10);
          emberB = parseInt(parts[2], 10);
        }
      } else {
        if (isDarkTheme) {
          emberR = 255;
          emberG = 95;
          emberB = 58;
        } else {
          emberR = 229;
          emberG = 72;
          emberB = 31;
        }
      }

      const fontVal = getComputedStyle(document.body).getPropertyValue("--font-plex-mono").trim();
      monoFont = fontVal || "'IBM Plex Mono', ui-monospace, monospace";
    };

    updateThemeAndFont();

    const particles: Particle[] = [];

    const resizeCanvas = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const targetCount = Math.round(Math.min(70, Math.max(30, (width / 1440) * 60)));
      while (particles.length < targetCount) {
        const p: Particle = {
          char: "",
          z: 0,
          size: 0,
          baseOpacity: 0,
          speed: 0,
          xRatio: 0,
          y: 0,
        };
        spawnParticle(p, true);
        particles.push(p);
      }
      if (particles.length > targetCount) {
        particles.length = targetCount;
      }
    };

    resizeCanvas();

    let pointerX = -9999;
    let pointerY = -9999;

    const handlePointerMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
    };

    const handlePointerLeave = () => {
      pointerX = -9999;
      pointerY = -9999;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    window.addEventListener("blur", handlePointerLeave);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let isReducedMotion = motionQuery.matches;

    const drawFrame = (time: number) => {
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const bottomFade = p.y <= 0.5 ? 1 : Math.max(0, (1 - p.y) / 0.5);
        const opacity = p.baseOpacity * bottomFade;
        if (opacity <= 0.005) continue;

        const sway = Math.sin(time * 0.0008 + p.z * 9) * 14;
        let px = p.xRatio * width + sway;
        let py = p.y * height;

        const dx = px - pointerX;
        const dy = py - pointerY;
        const dist = Math.hypot(dx, dy);

        if (dist < 200 && dist > 0.001) {
          const force = (200 - dist) * 0.3;
          const factor = force / dist;
          px += dx * factor;
          py += dy * factor;
        }

        if (p.z > 0.05) {
          ctx.shadowColor = `rgba(${emberR}, ${emberG}, ${emberB}, ${opacity * 0.75})`;
          ctx.shadowBlur = p.z * 14;
        } else {
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
        }

        ctx.fillStyle = `rgba(${emberR}, ${emberG}, ${emberB}, ${opacity})`;
        ctx.font = `${Math.round(p.size)}px ${monoFont}, ui-monospace, monospace`;
        ctx.fillText(p.char, px, py);
      }

      ctx.restore();
    };

    let rafId = 0;
    let lastTime = performance.now();

    const loop = (currentTime: number) => {
      const dt = Math.min((currentTime - lastTime) / 1000, 0.1);
      lastTime = currentTime;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.y -= p.speed * dt;
        if (p.y < -0.05) {
          spawnParticle(p, false);
        }
      }

      drawFrame(currentTime);
      rafId = requestAnimationFrame(loop);
    };

    if (isReducedMotion) {
      drawFrame(performance.now());
    } else {
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    }

    const onMotionChange = (e: MediaQueryListEvent) => {
      isReducedMotion = e.matches;
      if (isReducedMotion) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        drawFrame(performance.now());
      } else {
        if (!rafId && !document.hidden) {
          lastTime = performance.now();
          rafId = requestAnimationFrame(loop);
        }
      }
    };
    motionQuery.addEventListener("change", onMotionChange);

    const themeObserver = new MutationObserver(() => {
      updateThemeAndFont();
      if (isReducedMotion) {
        drawFrame(performance.now());
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const schemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const onSchemeChange = () => {
      updateThemeAndFont();
      if (isReducedMotion) {
        drawFrame(performance.now());
      }
    };
    schemeMedia.addEventListener("change", onSchemeChange);

    const handleVisibility = () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        if (!isReducedMotion && !rafId) {
          lastTime = performance.now();
          rafId = requestAnimationFrame(loop);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeCanvas();
        if (isReducedMotion) {
          drawFrame(performance.now());
        }
      }, 150);
    };
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      clearTimeout(resizeTimer);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("blur", handlePointerLeave);
      motionQuery.removeEventListener("change", onMotionChange);
      themeObserver.disconnect();
      schemeMedia.removeEventListener("change", onSchemeChange);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, [mounted]);

  if (!mounted) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="side-glyphs-canvas"
    />
  );
};
