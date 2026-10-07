"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

const subscribe = () => () => {};

export const AppearanceSettings = () => {
  const { theme, setTheme } = useTheme();
  // The stored theme is only known in the browser; render no selection on the
  // server so hydration matches.
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>
          System follows your device&apos;s light or dark setting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Theme"
          value={mounted ? theme : undefined}
          // Clicking the selected item emits "", which would clear the theme.
          onValueChange={(value) => value && setTheme(value)}
          className="w-full sm:w-auto"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="flex-1 gap-2 px-4 sm:flex-none"
            >
              <Icon aria-hidden="true" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardContent>
    </Card>
  );
};
