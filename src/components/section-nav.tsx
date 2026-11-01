"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { tabsListClassName, tabsTriggerClassName } from "@/components/ui/tabs";

export interface SectionNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** The exact route, else the one containing the path (Account has subpages). */
const useActiveHref = (items: SectionNavItem[]) => {
  const pathname = usePathname();
  return (
    items.find(({ href }) => pathname === href) ??
    items.find(({ href }) => pathname.startsWith(`${href}/`))
  )?.href;
};

/** A section's pages: sidebar on desktop, scrollable tab-style links below `lg`. */
export const SectionNav = ({ label, items }: { label: string; items: SectionNavItem[] }) => {
  const activeHref = useActiveHref(items);
  const tabsRef = useRef<HTMLElement>(null);
  // Which edges have hidden tabs, so the row fades there (#218).
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const updateOverflow = () => {
    const el = tabsRef.current;
    if (!el) return;
    setOverflow({
      left: el.scrollLeft > 0,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  };

  // At 375px the settings tabs overflow, so bring the current one into view (#218).
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    // Scroll the row only; scrollIntoView could also move the page.
    const active = el.querySelector('[aria-current="page"]');
    if (active) {
      const tab = active.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      el.scrollLeft += tab.left + tab.width / 2 - (row.left + row.width / 2);
    }
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeHref]);

  return (
    <>
      <nav aria-label={label} className="hidden lg:block w-48 shrink-0">
        <ul className="space-y-1">
          {items.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={href === activeHref ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  href === activeHref
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Page links styled as tabs; `data-state` reuses the tab active style. */}
      <nav
        ref={tabsRef}
        aria-label={label}
        onScroll={updateOverflow}
        className={cn(
          tabsListClassName,
          "w-full scroll-px-12 justify-start overflow-x-auto lg:hidden",
          overflow.left && "mask-l-from-85%",
          overflow.right && "mask-r-from-85%",
        )}
      >
        {items.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={href === activeHref ? "page" : undefined}
            data-state={href === activeHref ? "active" : "inactive"}
            className={tabsTriggerClassName}
          >
            <Icon aria-hidden="true" className="hidden sm:block" />
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
};
