"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SETTINGS_NAV } from "../nav";

/** The tab whose route contains the current path (Account has subpages). */
const useActiveHref = () => {
  const pathname = usePathname();
  return SETTINGS_NAV.find(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`),
  )?.href;
};

/** Sidebar on desktop, scrollable tabs below `lg`. */
export const SettingsNav = () => {
  const activeHref = useActiveHref();

  return (
    <>
      <nav aria-label="Settings" className="hidden lg:block w-48 shrink-0">
        <ul className="space-y-1">
          {SETTINGS_NAV.map(({ href, label, icon: Icon }) => (
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

      <Tabs value={activeHref ?? ""} className="lg:hidden">
        <TabsList
          aria-label="Settings"
          className="w-full justify-start overflow-x-auto"
        >
          {SETTINGS_NAV.map(({ href, label, icon: Icon }) => (
            <TabsTrigger key={href} value={href} asChild>
              <Link href={href}>
                <Icon aria-hidden="true" className="hidden sm:block" />
                {label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </>
  );
};
