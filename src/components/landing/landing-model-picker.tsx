"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { type PublicCatalogModel, pickableModels } from "@/features/ai-providers/catalog";
import { envCatalog, platformProviderId } from "@/features/ai-providers/platform";
import { setModel, useStoredAgentModel } from "@/features/conversations/hooks/use-agent-model";
import { MenuHeader } from "@/components/menu-chrome";
import { VendorIcon } from "@/components/vendor-icon";
import { cn } from "@/lib/utils";

const ENV_CATALOG = envCatalog(platformProviderId());

/** The model chip in the landing prompt box's header. */
export const LandingModelPicker = () => {
  // The models a new account gets: the admin's catalog (everyone's models),
  // else the env catalog's. The pick is saved where the dashboard reads it.
  const saved = useQuery(api.platformCatalog.getForVisitors);
  const catalog: {
    models: readonly (PublicCatalogModel & { hidden?: boolean })[];
    defaultModelId: string;
  } = saved ?? ENV_CATALOG;
  const models = pickableModels(catalog.models);
  const stored = useStoredAgentModel();
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  const selected =
    models.find((model) => !stored?.keyId && model.id === stored?.modelId) ??
    models.find((model) => model.id === catalog.defaultModelId) ??
    models[0];

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (saved === undefined || !selected) return null;

  return (
    <div ref={ref} className="relative flex">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${selected.name}`}
        onClick={() => setOpen((value) => !value)}
        className="flex h-full items-center gap-1.5 border-r border-border px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-foreground transition-colors hover:bg-muted/50 aria-expanded:bg-muted/50"
      >
        <span className="size-1.5 rounded-full bg-brand" />
        <span className="max-w-32 truncate whitespace-nowrap">{selected.name}</span>
        <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            // Lenis smooth-scrolls the page; this lets the wheel scroll the list instead.
            data-lenis-prevent
            initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 z-30 mb-2 max-h-80 w-72 origin-bottom-left overflow-y-auto overscroll-contain rounded-md border border-border bg-card normal-case tracking-normal shadow-[0_16px_48px_-20px_rgb(0_0_0/0.35)]"
          >
            <MenuHeader className="sticky top-0 z-10 bg-muted backdrop-blur">Agent model</MenuHeader>
            <ul role="listbox" aria-label="Model" className="p-1">
              {models.map((model) => {
                const active = model.id === selected.id;
                return (
                  <li key={model.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setModel({ modelId: model.id });
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left font-sans text-[13px] transition-colors",
                        active ? "bg-brand/[0.07] text-foreground" : "text-muted-foreground hover:bg-brand/[0.05] hover:text-foreground",
                      )}
                    >
                      <VendorIcon vendor={model.vendor} />
                      <span className="flex-1 truncate">{model.name}</span>
                      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                        {model.vendor}
                      </span>
                      <Check className={cn("size-3 text-brand", !active && "invisible")} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="sticky bottom-0 border-t border-border bg-card px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              Kept for your first project
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
