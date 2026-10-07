"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Recordings of the prompt → files → preview loop, played muted in a loop.
 * Empty until a real recording exists: the video then shows only its poster,
 * a screenshot of the IDE. Add e.g. `{ src: "/demo.webm", type: "video/webm" }`
 * (keep each file under 3 MB) to start playing it.
 */
const DEMO_SOURCES: { src: string; type: string }[] = [];

/** The product demo slot right below the hero. */
export const LandingDemo = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduceMotion = useReducedMotion();

  // autoPlay can start before the media query resolves, so pause explicitly.
  useEffect(() => {
    if (reduceMotion) videoRef.current?.pause();
  }, [reduceMotion]);

  return (
    <section aria-label="Product demo" className="relative pb-14 md:pb-20">
      <div className="max-w-5xl mx-auto px-6 md:px-8">
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card/50 shadow-sm">
          <video
            ref={videoRef}
            className="block aspect-video w-full object-cover"
            poster="/demo.jpg"
            aria-label="Codenaya IDE: chat with the agent, the file tree and the code editor"
            muted
            autoPlay={!reduceMotion}
            loop
            playsInline
            preload="none"
          >
            {DEMO_SOURCES.map((source) => (
              <source key={source.src} src={source.src} type={source.type} />
            ))}
          </video>
        </div>
      </div>
    </section>
  );
};
