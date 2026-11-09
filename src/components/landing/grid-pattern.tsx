"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export interface GridPatternProps {
  className?: string;
  size?: number;
}

export const GridPattern = ({ className, size = 48 }: GridPatternProps) => {
  // Unique per instance: the page renders more than one grid.
  const patternId = useId();
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 select-none",
        "opacity-[0.07] dark:opacity-[0.06]",
        className
      )}
    >
      <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern
            id={patternId}
            width={size}
            height={size}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${size} 0 L 0 0 0 ${size}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-foreground"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
};
