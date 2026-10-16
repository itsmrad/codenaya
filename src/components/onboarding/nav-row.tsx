"use client";

import { cn } from "@/lib/utils";

interface NavRowProps {
  onBack?: () => void;
  children: React.ReactNode; // the CTA button
}

export function NavRow({ onBack, children }: NavRowProps) {
  return (
    <div
      className={cn(
        "mt-auto flex max-w-[544px] items-center border-t border-border py-6",
        onBack ? "justify-between" : "justify-end"
      )}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Back
        </button>
      )}
      {children}
    </div>
  );
}
