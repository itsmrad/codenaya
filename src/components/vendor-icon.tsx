import type { IconType } from "react-icons";
import {
  SiAnthropic,
  SiGooglegemini,
  SiMeta,
  SiMistralai,
  SiOpenai,
  SiPerplexity,
  SiX,
} from "react-icons/si";

import { cn } from "@/lib/utils";

// Vendor names arrive in any case ("OpenAI", "openai"); match them lowercased.
const ICONS: Record<string, IconType> = {
  openai: SiOpenai,
  anthropic: SiAnthropic,
  google: SiGooglegemini,
  gemini: SiGooglegemini,
  meta: SiMeta,
  mistral: SiMistralai,
  xai: SiX,
  perplexity: SiPerplexity,
};

/** A model vendor's mark, or its initial in a small square when there is none. */
export const VendorIcon = ({ vendor, className }: { vendor: string; className?: string }) => {
  const Icon = ICONS[vendor.toLowerCase()];
  if (Icon) return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-muted font-mono text-[8px] uppercase text-muted-foreground",
        className,
      )}
    >
      {vendor.charAt(0)}
    </span>
  );
};
