"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { BellIcon, MonitorIcon, MoonIcon, SunIcon, Volume2Icon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useBuildSignalPreferences } from "@/hooks/use-build-signals";

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

  const {
    soundEnabled,
    notifEnabled,
    permission,
    toggleSound,
    toggleNotif,
  } = useBuildSignalPreferences();

  return (
    <div className="space-y-6">
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

      <Card>
        <CardHeader>
          <CardTitle>Build notifications</CardTitle>
          <CardDescription>
            Signals when an agent build or run finishes while you are in another tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Volume2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                <Label htmlFor="build-sound-switch" className="text-sm font-medium cursor-pointer">
                  Completion sound
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Plays a quiet chime when a build finishes while the tab is hidden.
              </p>
            </div>
            <Switch
              id="build-sound-switch"
              checked={mounted ? soundEnabled : false}
              onCheckedChange={toggleSound}
              aria-label="Completion sound"
            />
          </div>

          <div className="flex items-center justify-between gap-4 pt-4 border-t border-border/50">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <BellIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <Label htmlFor="build-notif-switch" className="text-sm font-medium cursor-pointer">
                  Browser notification
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                {permission === "denied"
                  ? "Notifications are blocked in your browser settings."
                  : "Sends a system notification with a one-click link to the Preview."}
              </p>
            </div>
            <Switch
              id="build-notif-switch"
              checked={mounted ? notifEnabled : false}
              disabled={permission === "denied"}
              onCheckedChange={toggleNotif}
              aria-label="Browser notification"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
